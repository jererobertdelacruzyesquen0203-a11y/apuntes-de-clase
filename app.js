"use strict";
/* Apuntes de Clase
   Graba la clase en partes de 5 minutos (se solapan 1,5 s para no cortar palabras),
   transcribe cada parte con Whisper en Groq (gratis) y genera un PDF.
   Todo se queda en este móvil: audio y texto en IndexedDB, ajustes en localStorage. */

const PARTE_SEG = Number(new URLSearchParams(location.search).get("parte")) || 300;
const SOLAPE_MS = 1500;
const BITRATE = 48000;                       // ~22 MB por hora, de sobra para voz
const API = "https://api.groq.com/openai/v1";
const $ = s => document.querySelector(s);

/* ---------- Ajustes ---------- */
function leerLS(k, def = "") { try { return localStorage.getItem(k) ?? def; } catch { return def; } }
function escribirLS(k, v) { try { localStorage.setItem(k, v); } catch {} }
const ajustes = {
  get clave() { return leerLS("apuntes_clave"); },
  set clave(v) { escribirLS("apuntes_clave", v); },
  get modelo() { return leerLS("apuntes_modelo", "whisper-large-v3"); },
  set modelo(v) { escribirLS("apuntes_modelo", v); },
};
let claveMala = false;

/* ---------- Base de datos ---------- */
let dbPromesa;
function db() {
  if (!dbPromesa) dbPromesa = new Promise((ok, mal) => {
    const r = indexedDB.open("apuntes", 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore("clases", { keyPath: "id" });
      const p = d.createObjectStore("partes", { keyPath: "id" });
      p.createIndex("clase", "claseId");
      p.createIndex("estado", "estado");
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  return dbPromesa;
}
async function tx(store, modo, fn) {
  const d = await db();
  return new Promise((ok, mal) => {
    const t = d.transaction(store, modo);
    const req = fn(t.objectStore(store));
    let res;
    if (req) req.onsuccess = () => { res = req.result; };
    t.oncomplete = () => ok(res);
    t.onerror = t.onabort = () => mal(t.error);
  });
}
const guardar = (store, obj) => tx(store, "readwrite", s => s.put(obj));
const leer = (store, id) => tx(store, "readonly", s => s.get(id));
const borrar = (store, id) => tx(store, "readwrite", s => s.delete(id));
const todas = store => tx(store, "readonly", s => s.getAll());
const porEstado = estado => tx("partes", "readonly", s => s.index("estado").getAll(estado));
const partesDe = id => tx("partes", "readonly", s => s.index("clase").getAll(id)).then(ps => ps.sort((a, b) => a.n - b.n));
const idParte = (claseId, n) => claseId + "-" + String(n).padStart(3, "0");

/* ---------- Utilidades ---------- */
const pad = n => String(n).padStart(2, "0");
const esperar = ms => new Promise(r => setTimeout(r, ms));
function reloj(s) {
  s = Math.max(0, Math.floor(s));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
function duracion(s) {
  s = Math.round(s || 0);
  if (s < 60) return s + " s";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${pad(m)} min` : `${m} min`;
}
const fmtFecha = new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const fmtFechaLarga = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
function normalizar(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}
function nombreBase(c) {
  const d = new Date(c.creada);
  const asig = c.asig.replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_|_$/g, "").slice(0, 40) || "Clase";
  return `Clase_${asig}_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function descargar(blob, nombre) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = nombre;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
let toastT;
function avisar(msg, ms = 4000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { t.hidden = true; }, ms);
}
function contar(ps) {
  const ok = ps.filter(p => p.estado === "ok").length;
  const err = ps.filter(p => p.estado === "error").length;
  return { ok, err, pend: ps.length - ok - err };
}

/* ---------- Texto: limpieza y párrafos ---------- */
// Frases que Whisper "inventa" en silencios (salen de subtítulos de YouTube)
const BASURA = [/amara\.org/i, /subt[ií]tul\w* (realizad|cread|hech|por)/i, /suscr[ií]b(e|ete)\b.*canal/i,
  /gracias por ver/i, /no olvides suscribirte/i, /thanks? (you )?for watching/i, /subtitles by/i];

function limpiar(segs, prompt) {
  const p = normalizar(prompt || "");
  const out = [];
  for (const s of segs) {
    const t = String(s.text || "").trim();
    if (!t) continue;
    if (BASURA.some(r => r.test(t))) continue;
    if ((s.no_speech_prob ?? 0) > 0.6 && (s.avg_logprob ?? 0) < -0.7) continue;  // silencio
    if ((s.compression_ratio ?? 0) > 2.8) continue;                              // bucle repetido
    const nt = normalizar(t);
    if (!nt) continue;
    if (nt.length > 20 && p.includes(nt)) continue;                              // repite el contexto
    if (out.length && normalizar(out[out.length - 1].t) === nt) continue;
    out.push({ s: +s.start || 0, e: +s.end || 0, t });
  }
  return out;
}

// Quita del comienzo de una parte las palabras que ya salieron al final de la anterior (solape)
function quitarSolape(previas, texto) {
  const orig = texto.split(/\s+/).filter(Boolean);
  const norm = orig.map(normalizar);
  const pv = previas.map(normalizar);
  for (let salto = 0; salto <= 1; salto++) {         // salto: primera palabra cortada a medias
    for (let k = Math.min(10, norm.length - salto, pv.length); k >= 2; k--) {
      let igual = true;
      for (let j = 0; j < k && igual; j++) igual = pv[pv.length - k + j] === norm[salto + j];
      if (igual) return orig.slice(salto + k).join(" ");
    }
  }
  return texto;
}

function armarTexto(partes) {
  const parrafos = [];
  let actual = null, ultimoFin = -Infinity, previas = [];
  for (const p of partes) {
    if (p.estado !== "ok" || !p.segs.length) { previas = []; continue; }
    p.segs.forEach((s, i) => {
      const texto = i === 0 && previas.length ? quitarSolape(previas, s.t) : s.t;
      if (!texto) return;
      const ini = p.ini + s.s, fin = p.ini + s.e;
      const largo = actual ? actual.texto.length : 0;
      if (!actual || ini - ultimoFin > 2.5 || (largo > 600 && /[.?!…]$/.test(actual.texto)) || largo > 1200) {
        actual = { t0: ini, texto: "" };
        parrafos.push(actual);
      }
      actual.texto += (actual.texto ? " " : "") + texto;
      ultimoFin = Math.max(ultimoFin, fin);
    });
    previas = p.segs.slice(-3).map(s => s.t).join(" ").split(/\s+/).filter(Boolean).slice(-15);
  }
  return parrafos;
}

/* ---------- Micrófono ---------- */
const grab = {
  ctx: null, stream: null, fuente: null, analizador: null, ruido: false,
  clase: null, rec: null, n: 0, acumulado: 0, desde: 0, pausado: false,
  timerParte: null, timerReloj: null, wake: null,
};

function contextoAudio() {
  if (!grab.ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) grab.ctx = new AC();
  }
  grab.ctx?.resume?.().catch(() => {});
  return grab.ctx;
}

async function abrirMicro(ruido) {
  const ctx = contextoAudio();   // se crea dentro del toque del usuario
  const vivo = grab.stream && grab.stream.getAudioTracks().some(t => t.readyState === "live");
  if (vivo && grab.ruido === ruido) return;
  cerrarMicro();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: ruido, autoGainControl: true, channelCount: 1 },
  });
  grab.stream = stream;
  grab.ruido = ruido;
  stream.getAudioTracks()[0].addEventListener("ended", microCortado);
  if (ctx) {
    grab.fuente = ctx.createMediaStreamSource(stream);
    grab.analizador = ctx.createAnalyser();
    grab.analizador.fftSize = 2048;
    grab.fuente.connect(grab.analizador);
    pintarNivel();
  }
}

function cerrarMicro() {
  grab.stream?.getTracks().forEach(t => { t.removeEventListener("ended", microCortado); t.stop(); });
  grab.fuente?.disconnect();
  grab.stream = grab.fuente = grab.analizador = null;
  $("#nivelNueva").style.width = $("#nivelGrab").style.width = "0";
}

function errorMicro(e) {
  if (e && e.name === "NotAllowedError")
    avisar("Necesito permiso para el micrófono: Ajustes del móvil → Apps → Chrome → Permisos → Micrófono → Permitir.", 9000);
  else avisar("No pude abrir el micrófono: " + (e?.message || e), 7000);
}

function microCortado() {
  if (grab.clase && !grab.pausado) {
    pausarReanudar();
    avisar("El micrófono se cortó (¿una llamada?). Pulsa «Reanudar» para seguir.", 9000);
  }
}

let rafNivel = 0;
function pintarNivel() {
  cancelAnimationFrame(rafNivel);
  const buf = new Float32Array(2048);
  let pico = 0, marca = 0;
  const paso = () => {
    if (!grab.analizador) return;
    grab.analizador.getFloatTimeDomainData(buf);
    let suma = 0;
    for (let i = 0; i < buf.length; i++) suma += buf[i] * buf[i];
    const db = 20 * Math.log10(Math.sqrt(suma / buf.length) + 1e-9);
    const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
    $("#nivelNueva").style.width = $("#nivelGrab").style.width = pct + "%";
    pico = Math.max(pico, pct);
    const ahora = performance.now();
    if (vista === "nueva" && ahora - marca > 1500) {
      $("#nivelTexto").textContent =
        pico < 25 ? "Se oye muy bajo: acerca el móvil a quien habla." :
        pico > 97 ? "Se oye muy fuerte: aleja un poco el móvil." :
        "Bien: así se oye correctamente.";
      pico = 0;
      marca = ahora;
    }
    rafNivel = requestAnimationFrame(paso);
  };
  paso();
}

/* ---------- Grabación ---------- */
function tipoAudio() {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"])
    if (MediaRecorder.isTypeSupported(t)) return t;
  return "";
}
const extension = tipo => tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
const tiempoClase = () => grab.acumulado + (grab.pausado ? 0 : (performance.now() - grab.desde) / 1000);

function nuevaParte() {
  if (!grab.clase || !grab.stream) return;
  const tipo = tipoAudio();
  const n = ++grab.n;
  const parte = { id: idParte(grab.clase.id, n), claseId: grab.clase.id, n, ini: tiempoClase(), dur: 0,
    tipo: tipo || "audio/webm", estado: "grabando", segs: [], error: "", blob: null };
  const rec = new MediaRecorder(grab.stream, tipo ? { mimeType: tipo, audioBitsPerSecond: BITRATE } : { audioBitsPerSecond: BITRATE });
  const trozos = [];
  const t0 = performance.now();
  let cadena = Promise.resolve();
  // Se guarda cada 15 s: si el móvil se apaga de golpe, se pierde como mucho eso
  const volcar = final => {
    parte.blob = new Blob(trozos, { type: parte.tipo });
    parte.dur = (performance.now() - t0) / 1000;
    if (final) parte.estado = "pendiente";
    const copia = { ...parte };
    cadena = cadena.then(() => guardar("partes", copia)).catch(e => console.error(e));
    return cadena;
  };
  rec.ondataavailable = e => { if (e.data && e.data.size) { trozos.push(e.data); volcar(false); } };
  rec.onstop = () => volcar(true).then(() => { pintar(); procesarCola(); });
  rec.onerror = e => avisar("Error de grabación: " + (e.error?.message || "desconocido"));
  rec.start(15000);

  const anterior = grab.rec;
  grab.rec = rec;
  if (anterior && anterior.state !== "inactive") setTimeout(() => { if (anterior.state !== "inactive") anterior.stop(); }, SOLAPE_MS);
  clearTimeout(grab.timerParte);
  grab.timerParte = setTimeout(nuevaParte, PARTE_SEG * 1000);
}

async function empezarClase() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    return avisar("Este navegador no puede grabar audio. Abre la app en Chrome.", 7000);
  contextoAudio();
  const ruido = $("#fRuido").checked;
  try { await abrirMicro(ruido); } catch (e) { return errorMicro(e); }
  const c = {
    id: "c" + Date.now(), asig: $("#fAsig").value.trim() || "Clase", tema: $("#fTema").value.trim(),
    claves: $("#fClaves").value.trim(), idioma: $("#fIdioma").value, creada: Date.now(), dur: 0, estado: "grabando",
  };
  escribirLS("apuntes_idioma", c.idioma);
  escribirLS("apuntes_ruido", ruido ? "1" : "");
  await guardar("clases", c);
  Object.assign(grab, { clase: c, n: 0, acumulado: 0, pausado: false, desde: performance.now(), rec: null });
  nuevaParte();
  grab.timerReloj = setInterval(tic, 500);
  tic();
  pedirWakeLock();
  pintarPausa();
  mostrar("grabando", c.id, "replace");
  if (!ajustes.clave) avisar("Aún no has puesto la clave de Groq: se graba igual y se transcribe cuando la pongas.", 7000);
}

async function pausarReanudar() {
  if (!grab.clase) return;
  if (grab.pausado) {
    contextoAudio();
    try { await abrirMicro(grab.ruido); } catch (e) { return errorMicro(e); }
    grab.pausado = false;
    grab.desde = performance.now();
    nuevaParte();
    pedirWakeLock();
  } else {
    grab.acumulado = tiempoClase();
    grab.pausado = true;
    clearTimeout(grab.timerParte);
    const r = grab.rec;
    grab.rec = null;
    if (r && r.state !== "inactive") r.stop();
  }
  pintarPausa();
}

async function terminarClase() {
  if (!grab.clase || !confirm("¿Terminar la grabación de esta clase?")) return;
  const c = grab.clase;
  clearTimeout(grab.timerParte);
  clearInterval(grab.timerReloj);
  c.dur = tiempoClase();
  c.estado = "lista";
  grab.pausado = true;
  const r = grab.rec;
  grab.rec = null;
  if (r && r.state !== "inactive") await new Promise(ok => { r.addEventListener("stop", ok, { once: true }); r.stop(); });
  await guardar("clases", c);
  grab.clase = null;
  cerrarMicro();
  soltarWakeLock();
  $("#negra").hidden = true;
  mostrar("clase", c.id, "replace");
  avisar("Clase guardada. Se está transcribiendo…");
}

function tic() {
  const t = reloj(tiempoClase());
  $("#reloj").textContent = t;
  $("#negraReloj").textContent = t;
}

function pintarPausa() {
  $("#v-grabando").classList.toggle("pausado", grab.pausado);
  $("#estadoGrab").textContent = grab.pausado ? "En pausa" : "Grabando";
  $("#btnPausa").textContent = grab.pausado ? "Reanudar" : "Pausa";
}

async function pedirWakeLock() {
  try { grab.wake = await navigator.wakeLock?.request("screen"); } catch {}
}
function soltarWakeLock() {
  grab.wake?.release().catch(() => {});
  grab.wake = null;
}

// Si la app se cerró de golpe grabando, se recupera lo guardado hasta ese momento
async function recuperar() {
  for (const c of await todas("clases")) {
    if (c.estado !== "grabando") continue;
    const ps = await partesDe(c.id);
    for (const p of ps) {
      if (p.estado !== "grabando") continue;
      p.estado = p.blob && p.blob.size ? "pendiente" : "error";
      if (p.estado === "error") p.error = "No llegó a guardarse audio";
      await guardar("partes", p);
    }
    c.estado = "lista";
    c.interrumpida = true;
    c.dur = ps.reduce((m, p) => Math.max(m, p.ini + p.dur), 0);
    await guardar("clases", c);
  }
}

/* ---------- Transcripción (Groq · Whisper) ---------- */
let colaActiva = false, reintentoT;
function programar(ms) { clearTimeout(reintentoT); reintentoT = setTimeout(procesarCola, ms); }
function procesarCola() { return cola().catch(e => console.error(e)); }

async function cola() {
  if (colaActiva) return;
  colaActiva = true;
  try {
    while (ajustes.clave && !claveMala && navigator.onLine) {
      const pendientes = await porEstado("pendiente");
      if (!pendientes.length) break;
      pendientes.sort((a, b) => a.claseId === b.claseId ? a.n - b.n : a.claseId < b.claseId ? -1 : 1);
      if (await transcribir(pendientes[0]) === "esperar") break;
      pintar();
    }
  } finally {
    colaActiva = false;
  }
  pintar();
}

function promptPara(c, previa) {
  const base = [c.asig, c.tema, c.claves].filter(Boolean).join(". ").slice(0, 220);
  const cola = previa?.segs?.length ? previa.segs.map(s => s.t).join(" ").slice(-180) : "";
  return [base && base + ".", cola].filter(Boolean).join(" ");
}

async function transcribir(p) {
  const c = await leer("clases", p.claseId);
  if (!c) { await borrar("partes", p.id); return "ok"; }
  if (!p.blob || !p.blob.size) {
    p.estado = "error"; p.error = "Esta parte no tiene audio";
    await guardar("partes", p);
    return "error";
  }
  const previa = p.n > 1 ? await leer("partes", idParte(p.claseId, p.n - 1)) : null;
  const prompt = promptPara(c, previa);
  const fd = new FormData();
  fd.append("file", p.blob, `parte-${p.n}.${extension(p.tipo)}`);
  fd.append("model", ajustes.modelo);
  fd.append("language", c.idioma || "es");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (prompt) fd.append("prompt", prompt);

  let res;
  const ctrl = new AbortController();
  const limite = setTimeout(() => ctrl.abort(), 180000);
  try {
    res = await fetch(API + "/audio/transcriptions", {
      method: "POST", headers: { Authorization: "Bearer " + ajustes.clave }, body: fd, signal: ctrl.signal,
    });
  } catch {
    programar(30000);          // sin conexión o muy lenta: se reintenta
    return "esperar";
  } finally {
    clearTimeout(limite);
  }
  if (res.status === 401) { claveMala = true; return "esperar"; }
  if (res.status === 429) {
    const s = Number(res.headers.get("retry-after")) || 60;
    avisar(`Límite gratis de Groq alcanzado por ahora. Sigo en ${Math.ceil(s / 60)} min.`);
    programar(s * 1000 + 1000);
    return "esperar";
  }
  if (res.status >= 500) { programar(60000); return "esperar"; }
  if (!res.ok) {
    let msg = "Error " + res.status;
    try { msg = (await res.json()).error?.message || msg; } catch {}
    p.estado = "error"; p.error = msg;
    await guardar("partes", p);
    return "error";
  }
  const json = await res.json();
  if (!await leer("clases", p.claseId)) return "ok";   // la borraron mientras tanto
  const segs = Array.isArray(json.segments) ? json.segments : [{ start: 0, end: p.dur, text: json.text || "" }];
  p.segs = limpiar(segs, prompt);
  p.estado = "ok";
  p.error = "";
  await guardar("partes", p);
  return "ok";
}

/* ---------- PDF ---------- */
// Las fuentes básicas del PDF solo tienen letras latinas: se cambian los símbolos que no caben
function pdfTxt(s) {
  return String(s)
    .replace(/[“”«»„]/g, '"').replace(/[‘’‚]/g, "'").replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/€/g, "EUR").replace(/[  ]/g, " ").normalize("NFC")
    .replace(/[^\x00-\xff]/g, ch => ch.normalize("NFD").replace(/[^\x00-\xff]/g, ""));
}

function hacerPdf(c, parrafos) {
  if (!window.jspdf) throw new Error("No se pudo cargar el creador de PDF. Abre la app una vez con internet.");
  const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
  const M = 18, ANCHO = 210 - 2 * M, LIMITE = 297 - 20;
  let y = M;
  const escribir = (txt, size, estilo, color, alto) => {
    doc.setFont("helvetica", estilo);
    doc.setFontSize(size);
    doc.setTextColor(...color);
    for (const l of doc.splitTextToSize(pdfTxt(txt), ANCHO)) {
      if (y + alto > LIMITE) { doc.addPage(); y = M; }
      y += alto;
      doc.text(l, M, y);
    }
  };
  escribir(c.asig, 20, "bold", [20, 24, 32], 8.5);
  if (c.tema) escribir(c.tema, 13, "normal", [60, 66, 80], 6.5);
  y += 1.5;
  escribir([fmtFechaLarga.format(c.creada), "Duración: " + duracion(c.dur), c.idioma === "en" ? "Inglés" : "Español"].join("   ·   "),
    9.5, "normal", [110, 116, 128], 5);
  y += 3;
  doc.setDrawColor(205, 210, 220);
  doc.setLineWidth(0.3);
  doc.line(M, y, M + ANCHO, y);
  y += 2;
  escribir("Transcripción automática de la clase. Puede haber errores en nombres propios o términos técnicos.",
    8.5, "italic", [130, 136, 148], 4.6);
  y += 3;
  for (const p of parrafos) {
    if (y + 4.6 + 2 * 5.4 > LIMITE) { doc.addPage(); y = M; }   // la hora nunca queda sola al final
    y += 1.5;
    escribir(reloj(p.t0), 8.5, "bold", [24, 130, 100], 4.6);
    escribir(p.texto, 11, "normal", [25, 28, 36], 5.4);
    y += 2.5;
  }
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(150, 154, 164);
    doc.text(pdfTxt("Apuntes de Clase · " + c.asig.slice(0, 60)), M, 297 - 10);
    doc.text(pdfTxt(`Página ${i} de ${total}`), 210 - M, 297 - 10, { align: "right" });
  }
  doc.setProperties({ title: pdfTxt(c.asig + (c.tema ? " - " + c.tema : "")), subject: "Transcripción de clase", creator: "Apuntes de Clase" });
  return doc.output("blob");
}

async function pdfDeClase(id) {
  const c = await leer("clases", id);
  const ps = await partesDe(id);
  const { pend } = contar(ps);
  if (pend) avisar("Ojo: aún faltan partes por transcribir, el PDF saldrá incompleto.", 5000);
  return { blob: hacerPdf(c, armarTexto(ps)), nombre: nombreBase(c) + ".pdf" };
}

async function descargarPdf() {
  try {
    const { blob, nombre } = await pdfDeClase(claseAbierta);
    descargar(blob, nombre);
    avisar("PDF guardado en Descargas.");
  } catch (e) { avisar(e.message, 7000); }
}

async function compartirPdf() {
  try {
    const { blob, nombre } = await pdfDeClase(claseAbierta);
    const archivo = new File([blob], nombre, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: nombre }); }
      catch (e) { if (e.name !== "AbortError") descargar(blob, nombre); }
    } else {
      descargar(blob, nombre);
      avisar("Este móvil no deja compartir directamente: el PDF quedó en Descargas.");
    }
  } catch (e) { avisar(e.message, 7000); }
}

async function copiarIA() {
  const c = await leer("clases", claseAbierta);
  const texto = armarTexto(await partesDe(c.id)).map(p => `[${reloj(p.t0)}] ${p.texto}`).join("\n\n");
  const todo = `Te paso la transcripción automática de mi clase de ${c.asig}${c.tema ? ` (tema: ${c.tema})` : ""}. ` +
`Puede tener errores de transcripción: corrígelos por el contexto.

Hazme:
1. Un resumen claro en 10-15 puntos.
2. Los conceptos y definiciones clave.
3. Todo lo que el profesor dijo que es importante o que entra en el examen.
4. 10 preguntas tipo examen con sus respuestas.

TRANSCRIPCIÓN:

${texto}`;
  try {
    await navigator.clipboard.writeText(todo);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = todo;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  avisar("Copiado. Pégalo en Claude, ChatGPT o Gemini.");
}

/* ---------- Acciones de una clase ---------- */
async function renombrar() {
  const c = await leer("clases", claseAbierta);
  const asig = prompt("Asignatura", c.asig);
  if (asig === null) return;
  const tema = prompt("Tema (puede quedar vacío)", c.tema || "");
  if (tema === null) return;
  c.asig = asig.trim() || c.asig;
  c.tema = tema.trim();
  await guardar("clases", c);
  pintar();
}

async function marcarPendientes(filtro, mensaje) {
  const ps = (await partesDe(claseAbierta)).filter(p => p.blob && filtro(p));
  if (!ps.length) return avisar("No hay audio guardado para volver a transcribir.");
  if (mensaje && !confirm(mensaje)) return;
  for (const p of ps) { p.estado = "pendiente"; p.error = ""; await guardar("partes", p); }
  claveMala = false;
  pintar();
  procesarCola();
}

async function descargarAudio() {
  const c = await leer("clases", claseAbierta);
  const ps = (await partesDe(c.id)).filter(p => p.blob);
  if (ps.length > 1) avisar(`Se descargan ${ps.length} archivos (uno por cada parte de 5 min).`);
  for (const p of ps) {
    descargar(p.blob, `${nombreBase(c)}_parte${pad(p.n)}.${extension(p.tipo)}`);
    await esperar(700);
  }
}

async function borrarAudios(ps) {
  let n = 0;
  for (const p of ps) if (p.blob && p.estado === "ok") { p.blob = null; await guardar("partes", p); n++; }
  return n;
}

async function borrarAudioClase() {
  if (!confirm("Se borra el audio y se queda el texto. Ya no podrás volver a transcribir esta clase. ¿Seguro?")) return;
  const n = await borrarAudios(await partesDe(claseAbierta));
  avisar(n ? "Audio borrado." : "Solo se borra el audio de las partes ya transcritas.");
  pintar();
}

async function borrarClase() {
  if (!confirm("¿Borrar esta clase con su texto y su audio? No se puede deshacer.")) return;
  for (const p of await partesDe(claseAbierta)) await borrar("partes", p.id);
  await borrar("clases", claseAbierta);
  history.back();
}

/* ---------- Ajustes ---------- */
async function guardarClave() {
  const v = $("#fClave").value.trim();
  const est = $("#claveEstado");
  ajustes.clave = v;
  claveMala = false;
  if (!v) { est.textContent = "Sin clave no se puede transcribir."; return; }
  est.textContent = "Probando…";
  try {
    const r = await fetch(API + "/models", { headers: { Authorization: "Bearer " + v } });
    if (r.ok) { est.textContent = "✓ Clave correcta. Ya puedes grabar."; procesarCola(); }
    else if (r.status === 401) { claveMala = true; est.textContent = "✗ Esa clave no funciona. Cópiala otra vez desde Groq."; }
    else est.textContent = `Guardada (Groq respondió ${r.status}). Se probará al transcribir.`;
  } catch {
    est.textContent = "Guardada. Ahora no hay internet para probarla.";
  }
}

async function limpiarAudios() {
  if (!confirm("Se borra el audio de todas las clases ya transcritas (el texto se queda). ¿Seguro?")) return;
  const n = await borrarAudios(await porEstado("ok"));
  avisar(n ? `Listo: borradas ${n} partes de audio.` : "No había audio que borrar.");
  pintar();
}

/* ---------- Pantallas ---------- */
const VISTAS = ["inicio", "nueva", "grabando", "clase", "ajustes"];
const TITULOS = { inicio: "Apuntes de Clase", nueva: "Nueva clase", grabando: "Grabando", clase: "Clase", ajustes: "Ajustes" };
let vista = "inicio", claseAbierta = null;

function mostrar(v, id = null, historial = "push") {
  if (vista === "nueva" && v !== "grabando" && !grab.clase) cerrarMicro();
  vista = v;
  claseAbierta = id;
  for (const x of VISTAS) $("#v-" + x).hidden = x !== v;
  $("#titulo").textContent = TITULOS[v];
  $("#btnAtras").hidden = v === "inicio" || v === "grabando";
  $("#btnAjustes").hidden = v === "grabando" || v === "ajustes";
  if (historial === "push") history.pushState({ v, id }, "");
  else if (historial === "replace") history.replaceState({ v, id }, "");
  window.scrollTo(0, 0);
  pintar();
}

window.addEventListener("popstate", e => {
  if (grab.clase) {
    history.pushState({ v: "grabando", id: grab.clase.id }, "");
    avisar("Estás grabando. Para salir, pulsa «Terminar clase».");
    return;
  }
  let st = e.state || { v: "inicio" };
  if (st.v === "grabando") st = { v: "inicio" };
  mostrar(st.v, st.id, false);
});

function pintar() {
  const f = { inicio: pintarInicio, clase: pintarClase, grabando: pintarGrabando, ajustes: pintarAjustes, nueva: pintarNueva }[vista];
  return f().catch(e => console.error(e));
}

async function pintarInicio() {
  $("#avisoClave").hidden = !!ajustes.clave && !claveMala;
  const clases = (await todas("clases")).sort((a, b) => b.creada - a.creada);
  const grupos = {};
  for (const p of await todas("partes")) (grupos[p.claseId] ||= []).push(p);
  const lista = $("#lista");
  lista.textContent = "";
  for (const c of clases) {
    const b = document.createElement("button");
    b.className = "item";
    const t = document.createElement("span"); t.className = "t"; t.textContent = c.asig + (c.tema ? " · " + c.tema : "");
    const s = document.createElement("span"); s.className = "s"; s.textContent = fmtFecha.format(c.creada) + " · " + duracion(c.dur);
    const e = document.createElement("span"); e.className = "e";
    const { ok, err, pend } = contar(grupos[c.id] || []);
    if (c.estado === "grabando") { e.textContent = "● Grabando ahora"; e.classList.add("rec"); }
    else if (pend) { e.textContent = `Transcribiendo… ${ok} de ${ok + err + pend} partes` + (navigator.onLine ? "" : " (sin internet)"); e.classList.add("pend"); }
    else if (err) { e.textContent = `⚠ ${err} parte(s) con error`; e.classList.add("err"); }
    else e.textContent = "✓ Lista";
    b.append(t, s, e);
    b.onclick = () => mostrar(grab.clase?.id === c.id ? "grabando" : "clase", c.id);
    lista.append(b);
  }
  $("#vacio").hidden = clases.length > 0;
}

function pintarParrafos(el, parrafos, vacio) {
  el.textContent = "";
  if (!parrafos.length) {
    const p = document.createElement("p");
    p.className = "ayuda";
    p.textContent = vacio;
    el.append(p);
    return;
  }
  for (const x of parrafos) {
    const p = document.createElement("p");
    p.className = "parrafo";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = reloj(x.t0);
    p.append(ts, x.texto);
    el.append(p);
  }
}

function motivoEspera() {
  if (!ajustes.clave) return "Falta poner la clave de Groq en Ajustes (⚙).";
  if (claveMala) return "La clave de Groq no funciona: revísala en Ajustes (⚙).";
  if (!navigator.onLine) return "Sin internet: seguirá solo cuando te conectes.";
  return "";
}

async function pintarClase() {
  const c = await leer("clases", claseAbierta);
  if (!c) return mostrar("inicio", null, "replace");
  const ps = await partesDe(c.id);
  $("#titulo").textContent = c.asig;
  $("#claseMeta").textContent = [c.tema, fmtFechaLarga.format(c.creada), duracion(c.dur)].filter(Boolean).join(" · ");

  const { ok, err, pend } = contar(ps);
  const est = $("#claseEstado");
  est.textContent = "";
  const lineas = [];
  if (pend) lineas.push(`Transcribiendo… ${ok} de ${ps.length} partes listas. ${motivoEspera()}`);
  if (err) lineas.push(`${err} parte(s) no se pudieron transcribir: ${ps.find(p => p.estado === "error").error}`);
  if (c.interrumpida) lineas.push("La grabación se cortó de golpe; se guardó todo hasta ese momento.");
  for (const l of lineas) { const p = document.createElement("p"); p.textContent = l.trim(); est.append(p); }
  if (err) {
    const b = document.createElement("button");
    b.className = "btn";
    b.textContent = "Reintentar las que fallaron";
    b.onclick = () => marcarPendientes(p => p.estado === "error");
    est.append(b);
  }
  est.hidden = !lineas.length;

  const parrafos = armarTexto(ps);
  pintarParrafos($("#claseTexto"), parrafos, pend ? "El texto aparecerá aquí en cuanto se transcriba." : "No hay texto en esta clase.");
  for (const id of ["#btnPdf", "#btnCompartir", "#btnCopiarIA"]) $(id).disabled = !parrafos.length;
  const hayAudio = ps.some(p => p.blob);
  $("#btnAudio").disabled = $("#btnBorrarAudio").disabled = $("#btnRetranscribir").disabled = !hayAudio;
}

async function pintarGrabando() {
  if (!grab.clase) return;
  $("#titulo").textContent = grab.clase.asig;
  const ps = await partesDe(grab.clase.id);
  const ok = ps.filter(p => p.estado === "ok").length;
  const enCola = ps.filter(p => p.estado === "pendiente").length;
  $("#infoPartes").textContent = [`Partes transcritas: ${ok}`, enCola ? `en cola: ${enCola}` : "", motivoEspera()].filter(Boolean).join(" · ");
  const el = $("#textoVivo");
  const abajo = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
  const min = Math.max(1, Math.round(PARTE_SEG / 60));
  pintarParrafos(el, armarTexto(ps).slice(-8), `El texto irá apareciendo aquí cada ${min} min más o menos.`);
  if (abajo) el.scrollTop = el.scrollHeight;
}

async function pintarAjustes() {
  $("#fClave").value = ajustes.clave;
  $("#fModelo").value = ajustes.modelo;
  if (claveMala) $("#claveEstado").textContent = "✗ La clave guardada no funciona. Pega una nueva.";
  const e = await navigator.storage?.estimate?.().catch(() => null);
  if (e) $("#espacio").textContent = `Esta app ocupa ${Math.round(e.usage / 1048576)} MB. Cada hora de audio son unos 22 MB.`;
}

async function pintarNueva() {
  const asigs = [...new Set((await todas("clases")).sort((a, b) => b.creada - a.creada).map(c => c.asig))];
  const dl = $("#asigs");
  dl.textContent = "";
  for (const a of asigs) { const o = document.createElement("option"); o.value = a; dl.append(o); }
}

/* ---------- Botones ---------- */
function enlazar() {
  $("#btnAtras").onclick = () => history.back();
  $("#btnAjustes").onclick = () => mostrar("ajustes");
  $("#btnIrClave").onclick = () => mostrar("ajustes");
  $("#btnNueva").onclick = () => {
    $("#fTema").value = $("#fClaves").value = "";
    $("#fIdioma").value = leerLS("apuntes_idioma", "es");
    $("#fRuido").checked = !!leerLS("apuntes_ruido");
    $("#nivelTexto").textContent = "Habla un momento: la barra debe moverse.";
    mostrar("nueva");
    if (!navigator.mediaDevices?.getUserMedia) return avisar("Este navegador no puede grabar audio. Abre la app en Chrome.", 7000);
    abrirMicro($("#fRuido").checked).catch(errorMicro);
  };
  $("#fRuido").onchange = () => abrirMicro($("#fRuido").checked).catch(errorMicro);
  $("#btnEmpezar").onclick = () => empezarClase().catch(e => avisar("No se pudo empezar: " + e.message, 7000));
  $("#btnPausa").onclick = () => pausarReanudar();
  $("#btnTerminar").onclick = () => terminarClase();
  $("#btnNegra").onclick = () => { $("#negra").hidden = false; };
  let ultimoToque = 0;
  $("#negra").addEventListener("pointerup", () => {
    const ahora = Date.now();
    if (ahora - ultimoToque < 450) $("#negra").hidden = true;
    ultimoToque = ahora;
  });
  // el texto se mueve cada 30 s para no marcar la pantalla
  setInterval(() => {
    if ($("#negra").hidden) return;
    $("#negraCaja").style.transform = `translate(${10 + Math.random() * 40}vw, ${10 + Math.random() * 65}vh)`;
  }, 30000);

  $("#btnPdf").onclick = descargarPdf;
  $("#btnCompartir").onclick = compartirPdf;
  $("#btnCopiarIA").onclick = copiarIA;
  $("#btnRenombrar").onclick = renombrar;
  $("#btnRetranscribir").onclick = () => marcarPendientes(() => true, "Se vuelve a transcribir toda la clase (útil si cambiaste la calidad o las palabras clave). ¿Seguir?");
  $("#btnAudio").onclick = descargarAudio;
  $("#btnBorrarAudio").onclick = borrarAudioClase;
  $("#btnBorrar").onclick = borrarClase;

  $("#btnGuardarClave").onclick = guardarClave;
  $("#btnVerClave").onclick = () => {
    const f = $("#fClave");
    f.type = f.type === "password" ? "text" : "password";
    $("#btnVerClave").textContent = f.type === "password" ? "Ver" : "Ocultar";
  };
  $("#fModelo").onchange = () => { ajustes.modelo = $("#fModelo").value; };
  $("#btnLimpiar").onclick = limpiarAudios;

  addEventListener("online", () => { procesarCola(); pintar(); });
  addEventListener("offline", () => pintar());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (grab.clase && !grab.pausado) pedirWakeLock();
    procesarCola();
    pintar();
  });
  addEventListener("beforeunload", e => { if (grab.clase) { e.preventDefault(); e.returnValue = ""; } });
}

async function iniciar() {
  enlazar();
  history.replaceState({ v: "inicio" }, "");
  try { await recuperar(); } catch (e) { console.error(e); }
  mostrar("inicio", null, false);
  procesarCola();
  setInterval(procesarCola, 60000);
  navigator.storage?.persist?.().catch(() => {});
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}
iniciar();
