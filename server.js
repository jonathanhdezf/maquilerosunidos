const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const express = require('express');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const PDF_DIR = path.join(DATA_DIR, 'pdfs');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const HTML_FILE = path.join(ROOT_DIR, 'maquileros-unidos.html');

const CONTACT = {
  companyName: process.env.COMPANY_NAME || 'Maquileros Unidos de la Sierra',
  email: process.env.CONTACT_EMAIL || 'contacto@maquilerosunidos.mx',
  whatsappNumber: String(process.env.WHATSAPP_NUMBER || '522381234567').replace(/\D/g, ''),
  whatsappLabel: process.env.WHATSAPP_LABEL || '238 123 4567',
};

const CAPACIDAD_OPTIONS = new Set(['50-100', '100-200', '200-500', '500+']);
const MAQUINA_OPTIONS = new Set(['si', 'acceso', 'no']);
const RED_OPTIONS = new Set(['', 'si', 'tal-vez', 'no']);
const FUENTE_OPTIONS = new Set(['', 'facebook', 'recomendacion', 'google', 'instagram', 'otro']);
const TIPO_OPTIONS = new Set(['recta', 'overlock', 'collareta', 'pretinado', 'ojal', 'otro']);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/data/pdfs', express.static(PDF_DIR));
app.use(express.static(ROOT_DIR, { index: false }));

app.get('/', (_req, res) => {
  res.sendFile(HTML_FILE);
});

app.get('/api/config/public', (_req, res) => {
  res.json({
    companyName: CONTACT.companyName,
    email: CONTACT.email,
    whatsappLabel: CONTACT.whatsappLabel,
    whatsappUrl: getWhatsappUrl(),
    emailUrl: `mailto:${CONTACT.email}`,
  });
});

app.post('/api/solicitudes', async (req, res) => {
  try {
    const payload = normalizeSubmission(req.body);
    const errors = validateSubmission(payload);

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, errors });
    }

    const submission = {
      id: buildSubmissionId(),
      createdAt: new Date().toISOString(),
      ...payload,
      score: buildLeadScore(payload),
      qualifiesForDirectWhatsapp: qualifiesForDirectWhatsapp(payload),
    };

    await ensureStorage();
    await saveSubmission(submission);

    const pdfFilename = `${submission.id}.pdf`;
    const pdfPath = path.join(PDF_DIR, pdfFilename);
    await generateSubmissionPdf(submission, pdfPath);

    const emailResult = await sendNotificationEmail(submission, pdfPath);

    res.status(201).json({
      ok: true,
      message: 'Solicitud recibida correctamente.',
      submissionId: submission.id,
      pdfUrl: `/data/pdfs/${pdfFilename}`,
      qualifiesForDirectWhatsapp: submission.qualifiesForDirectWhatsapp,
      contact: {
        companyName: CONTACT.companyName,
        email: CONTACT.email,
        emailUrl: `mailto:${CONTACT.email}`,
        whatsappLabel: CONTACT.whatsappLabel,
        whatsappUrl: getWhatsappUrl(),
      },
      emailNotification: emailResult,
    });
  } catch (error) {
    console.error('Error al procesar solicitud:', error);
    res.status(500).json({
      ok: false,
      message: 'No fue posible procesar la solicitud en este momento.',
    });
  }
});

app.listen(PORT, async () => {
  await ensureStorage();
  console.log(`Servidor activo en http://localhost:${PORT}`);
});

function normalizeSubmission(body) {
  const tipos = Array.isArray(body.tipo)
    ? body.tipo
    : body.tipo
      ? [body.tipo]
      : [];

  return {
    nombre: cleanText(body.nombre),
    municipio: cleanText(body.municipio),
    telefono: cleanText(body.telefono),
    maquina: cleanText(body.maquina),
    capacidad: cleanText(body.capacidad),
    tipo: [...new Set(tipos.map((item) => cleanText(item)).filter(Boolean))],
    red: cleanText(body.red),
    fuente: cleanText(body.fuente),
    experiencia: cleanText(body.experiencia, 1200),
  };
}

function validateSubmission(payload) {
  const errors = [];

  if (payload.nombre.length < 5) errors.push('El nombre completo es obligatorio.');
  if (payload.municipio.length < 3) errors.push('El municipio o colonia es obligatorio.');
  if (!/^[\d\s()+-]{8,20}$/.test(payload.telefono)) errors.push('El telefono no tiene un formato valido.');
  if (!MAQUINA_OPTIONS.has(payload.maquina)) errors.push('Debes indicar si tienes maquina de coser.');
  if (!CAPACIDAD_OPTIONS.has(payload.capacidad)) errors.push('Debes seleccionar tu capacidad semanal.');
  if (payload.tipo.length === 0) errors.push('Selecciona al menos un tipo de maquila.');
  if (payload.tipo.some((value) => !TIPO_OPTIONS.has(value))) errors.push('Uno de los tipos de maquila no es valido.');
  if (!RED_OPTIONS.has(payload.red)) errors.push('La opcion de red de apoyo no es valida.');
  if (!FUENTE_OPTIONS.has(payload.fuente)) errors.push('La opcion de origen del contacto no es valida.');

  return errors;
}

function qualifiesForDirectWhatsapp(payload) {
  return payload.maquina === 'si' && ['100-200', '200-500', '500+'].includes(payload.capacidad);
}

function buildLeadScore(payload) {
  let score = 0;
  if (payload.maquina === 'si') score += 30;
  if (payload.maquina === 'acceso') score += 15;
  if (payload.capacidad === '100-200') score += 20;
  if (payload.capacidad === '200-500') score += 30;
  if (payload.capacidad === '500+') score += 40;
  if (payload.red === 'si') score += 15;
  if (payload.tipo.includes('recta')) score += 5;
  if (payload.tipo.includes('overlock')) score += 5;
  if (payload.tipo.includes('collareta')) score += 5;
  return score;
}

function cleanText(value, maxLength = 160) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function buildSubmissionId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SOL-${stamp}-${random}`;
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(PDF_DIR, { recursive: true });

  try {
    await fsp.access(SUBMISSIONS_FILE);
  } catch {
    await fsp.writeFile(SUBMISSIONS_FILE, '[]\n', 'utf8');
  }
}

async function saveSubmission(submission) {
  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  current.push(submission);
  await fsp.writeFile(SUBMISSIONS_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

async function generateSubmissionPdf(submission, outputPath) {
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(outputPath);

    doc.pipe(stream);

    doc.rect(0, 0, doc.page.width, 120).fill('#1A1A18');
    doc.fillColor('#E8C96E')
      .fontSize(24)
      .text(CONTACT.companyName, 50, 42, { align: 'left' });

    doc.fillColor('#F5EDD6')
      .fontSize(11)
      .text('Confirmacion de solicitud laboral', 50, 78);

    doc.moveDown(4);
    doc.fillColor('#1A1A18')
      .fontSize(20)
      .text('Resumen de la solicitud');

    doc.moveDown(1);
    drawField(doc, 'Folio', submission.id);
    drawField(doc, 'Fecha', new Date(submission.createdAt).toLocaleString('es-MX'));
    drawField(doc, 'Nombre', submission.nombre);
    drawField(doc, 'Municipio / Colonia', submission.municipio);
    drawField(doc, 'Telefono', submission.telefono);
    drawField(doc, 'Tiene maquina', labelMaquina(submission.maquina));
    drawField(doc, 'Capacidad semanal', submission.capacidad);
    drawField(doc, 'Tipos de maquila', submission.tipo.map(labelTipo).join(', '));
    drawField(doc, 'Red de apoyo', labelRed(submission.red));
    drawField(doc, 'Como se entero', labelFuente(submission.fuente));
    drawField(doc, 'Experiencia', submission.experiencia || 'No proporcionada');
    drawField(doc, 'Prioridad interna', `${submission.score} puntos`);

    doc.moveDown(1.5);
    doc.fontSize(16).fillColor('#1A1A18').text('Contacto directo');
    doc.moveDown(0.5);
    doc.fontSize(11).fillColor('#333333')
      .text('Si deseas dar seguimiento inmediato a tu solicitud, usa cualquiera de estos canales:');

    const buttonY = doc.y + 18;
    drawActionButton(doc, 50, buttonY, 220, 34, '#25D366', 'WhatsApp', getWhatsappUrl());
    drawActionButton(doc, 290, buttonY, 220, 34, '#C9A84C', 'Correo electronico', `mailto:${CONTACT.email}`);

    doc.moveDown(5);
    doc.fontSize(10).fillColor('#666666')
      .text(`WhatsApp: ${CONTACT.whatsappLabel} | Correo: ${CONTACT.email}`);

    doc.end();

    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

function drawField(doc, label, value) {
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#3D6230').text(label.toUpperCase());
  doc.font('Helvetica').fontSize(12).fillColor('#1A1A18').text(value || '-');
  doc.moveDown(0.6);
}

function drawActionButton(doc, x, y, width, height, color, label, url) {
  doc.roundedRect(x, y, width, height, 6).fill(color);
  doc.fillColor('#FFFFFF')
    .font('Helvetica-Bold')
    .fontSize(12)
    .text(label, x, y + 10, { width, align: 'center', link: url, underline: false });
  doc.link(x, y, width, height, url);
}

async function sendNotificationEmail(submission, pdfPath) {
  const transport = createTransport();
  if (!transport) {
    return { sent: false, reason: 'SMTP no configurado' };
  }

  await transport.sendMail({
    from: process.env.SMTP_FROM || `No Reply <${CONTACT.email}>`,
    to: CONTACT.email,
    subject: `Nueva solicitud laboral ${submission.id}`,
    text: [
      `Se recibio una nueva solicitud de ${submission.nombre}.`,
      `Telefono: ${submission.telefono}`,
      `Municipio: ${submission.municipio}`,
      `Capacidad: ${submission.capacidad}`,
      `Tipos: ${submission.tipo.join(', ')}`,
    ].join('\n'),
    attachments: [
      {
        filename: `${submission.id}.pdf`,
        path: pdfPath,
      },
    ],
  });

  return { sent: true };
}

function createTransport() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

function getWhatsappUrl() {
  return `https://wa.me/${CONTACT.whatsappNumber}`;
}

function labelMaquina(value) {
  return ({
    si: 'Si, cuenta con maquina propia',
    acceso: 'Tiene acceso a una maquina',
    no: 'No tiene maquina',
  })[value] || value;
}

function labelTipo(value) {
  return ({
    recta: 'Costura recta',
    overlock: 'Overlock',
    collareta: 'Collareta',
    pretinado: 'Pretinado',
    ojal: 'Ojales y botones',
    otro: 'Otro tipo',
  })[value] || value;
}

function labelRed(value) {
  return ({
    '': 'No especificado',
    si: 'Si, varias personas',
    'tal-vez': 'Tal vez',
    no: 'No, solo la persona solicitante',
  })[value] || value;
}

function labelFuente(value) {
  return ({
    '': 'No especificado',
    facebook: 'Facebook',
    recomendacion: 'Recomendacion',
    google: 'Google',
    instagram: 'Instagram',
    otro: 'Otro medio',
  })[value] || value;
}
