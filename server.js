const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
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
const ADMIN_HTML_FILE = path.join(ROOT_DIR, 'admin.html');
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-now';
const SESSION_COOKIE = 'mu_admin_session';
const IS_VERCEL = Boolean(process.env.VERCEL);

const CONTACT = {
  companyName: process.env.COMPANY_NAME || 'Maquileros Unidos de la Sierra',
  email: process.env.CONTACT_EMAIL || 'contacto@maquilerosunidos.mx',
  whatsappNumber: String(process.env.WHATSAPP_NUMBER || '522381234567').replace(/\D/g, ''),
  whatsappLabel: process.env.WHATSAPP_LABEL || '238 123 4567',
};
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || 'solicitudes';
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || '';
const supabase = createSupabaseClient();

const CAPACIDAD_OPTIONS = new Set(['50-100', '100-200', '200-500', '500+']);
const MAQUINA_OPTIONS = new Set(['si', 'acceso', 'no']);
const RED_OPTIONS = new Set(['', 'si', 'tal-vez', 'no']);
const FUENTE_OPTIONS = new Set(['', 'facebook', 'recomendacion', 'google', 'instagram', 'otro']);
const TIPO_OPTIONS = new Set(['recta', 'overlock', 'collareta', 'pretinado', 'ojal', 'otro']);
const STATUS_OPTIONS = new Set(['nuevo', 'contactado', 'en-seguimiento', 'cerrado', 'descartado']);
const SORT_MAP = {
  'created_at.desc': { column: 'created_at', ascending: false },
  'score.desc': { column: 'score', ascending: false },
  'follow_up_at.asc': { column: 'follow_up_at', ascending: true },
};

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/data/pdfs', express.static(PDF_DIR));

app.get('/', (_req, res) => {
  res.sendFile(HTML_FILE);
});

app.get('/admin', requireAdminPageAccess, (_req, res) => {
  res.sendFile(ADMIN_HTML_FILE);
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

app.get('/api/admin/session', requireAdminApiAuth, (_req, res) => {
  res.json({ ok: true, user: ADMIN_USERNAME });
});

app.post('/api/admin/login', (req, res) => {
  const username = cleanText(req.body.username, 64);
  const password = String(req.body.password || '');

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      ok: false,
      message: 'El panel no tiene contraseña configurada en el servidor.',
    });
  }

  const usernameOk = safeEqual(username, ADMIN_USERNAME);
  const passwordOk = safeEqual(password, ADMIN_PASSWORD);

  if (!usernameOk || !passwordOk) {
    return res.status(401).json({
      ok: false,
      message: 'Credenciales inválidas.',
    });
  }

  setSessionCookie(res, ADMIN_USERNAME);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/solicitudes', requireAdminApiAuth, async (req, res) => {
  try {
    const filters = {
      status: cleanText(req.query.status, 40),
      search: cleanText(req.query.search, 120),
      sort: cleanText(req.query.sort, 40) || 'created_at.desc',
    };

    const data = await listSubmissions(filters);

    res.json({
      ok: true,
      data,
      meta: {
        total: data.length,
        byStatus: summarizeStatuses(data),
      },
    });
  } catch (error) {
    console.error('Error al listar solicitudes:', error);
    res.status(500).json({
      ok: false,
      message: 'No fue posible cargar las solicitudes.',
    });
  }
});

app.patch('/api/admin/solicitudes/:submissionId', requireAdminApiAuth, async (req, res) => {
  try {
    const submissionId = cleanText(req.params.submissionId, 64);
    const payload = normalizeAdminUpdate(req.body);
    const errors = validateAdminUpdate(payload);

    if (!submissionId) {
      return res.status(400).json({ ok: false, message: 'Folio inválido.' });
    }

    if (errors.length > 0) {
      return res.status(400).json({ ok: false, message: errors.join(' ') });
    }

    const updated = await updateSubmission(submissionId, payload);
    res.json({ ok: true, data: updated });
  } catch (error) {
    console.error('Error al actualizar solicitud:', error);
    const status = error.message === 'NOT_FOUND' ? 404 : 500;
    res.status(status).json({
      ok: false,
      message: status === 404 ? 'Solicitud no encontrada.' : 'No fue posible actualizar la solicitud.',
    });
  }
});

app.delete('/api/admin/solicitudes/:submissionId', requireAdminApiAuth, async (req, res) => {
  try {
    const submissionId = cleanText(req.params.submissionId, 64);

    if (!submissionId) {
      return res.status(400).json({ ok: false, message: 'Folio inválido.' });
    }

    await deleteSubmission(submissionId);
    res.json({ ok: true });
  } catch (error) {
    console.error('Error al eliminar solicitud:', error);
    const status = error.message === 'NOT_FOUND' ? 404 : 500;
    res.status(status).json({
      ok: false,
      message: status === 404 ? 'Solicitud no encontrada.' : 'No fue posible eliminar la solicitud.',
    });
  }
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
      status: 'nuevo',
      notes: '',
      assignedTo: null,
      followUpAt: null,
      lastContactedAt: null,
      pdfUrl: null,
    };

    await saveSubmission(submission);

    let pdfAsset = null;
    try {
      await ensureStorage();
      pdfAsset = await persistSubmissionPdf(submission);
      submission.pdfUrl = pdfAsset.pdfUrl || null;

      if (submission.pdfUrl) {
        await updateSubmissionPdfUrl(submission.id, submission.pdfUrl);
      }
    } catch (error) {
      console.error('Error al generar o persistir PDF:', error);
    }

    let emailResult = { sent: false, reason: 'SMTP no configurado' };
    try {
      emailResult = await sendNotificationEmail(submission, pdfAsset?.emailAttachment || null);
    } catch (error) {
      console.error('Error al enviar correo de notificación:', error);
      emailResult = { sent: false, reason: 'Error al enviar correo' };
    }

    res.status(201).json({
      ok: true,
      message: 'Solicitud recibida correctamente.',
      submissionId: submission.id,
      pdfUrl: submission.pdfUrl,
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

function normalizeAdminUpdate(body) {
  return {
    status: cleanText(body.status, 40),
    notes: cleanText(body.notes, 5000),
    assignedTo: cleanText(body.assignedTo, 120) || null,
    followUpAt: normalizeDateValue(body.followUpAt),
    lastContactedAt: normalizeDateValue(body.lastContactedAt),
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

function validateAdminUpdate(payload) {
  const errors = [];
  if (!STATUS_OPTIONS.has(payload.status)) errors.push('El estado no es válido.');
  if (payload.followUpAt && Number.isNaN(Date.parse(payload.followUpAt))) errors.push('La fecha de seguimiento no es válida.');
  if (payload.lastContactedAt && Number.isNaN(Date.parse(payload.lastContactedAt))) errors.push('La fecha de último contacto no es válida.');
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
  if (shouldUseSupabaseStorage() || IS_VERCEL) {
    return;
  }

  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(PDF_DIR, { recursive: true });

  try {
    await fsp.access(SUBMISSIONS_FILE);
  } catch {
    await fsp.writeFile(SUBMISSIONS_FILE, '[]\n', 'utf8');
  }
}

async function saveSubmission(submission) {
  if (supabase) {
    const { error } = await supabase
      .from(SUPABASE_TABLE)
      .insert(buildSupabaseRow(submission));

    if (error) {
      throw new Error(`Supabase insert failed: ${error.message}`);
    }

    return;
  }

  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  current.push(submission);
  await fsp.writeFile(SUBMISSIONS_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

async function updateSubmissionPdfUrl(submissionId, pdfUrl) {
  if (supabase) {
    const { error } = await supabase
      .from(SUPABASE_TABLE)
      .update({ pdf_url: pdfUrl })
      .eq('submission_id', submissionId);

    if (error) {
      throw new Error(`Supabase pdf update failed: ${error.message}`);
    }

    return;
  }

  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  const index = current.findIndex((item) => item.id === submissionId || item.submission_id === submissionId);
  if (index < 0) return;

  current[index] = {
    ...current[index],
    pdfUrl,
  };

  await fsp.writeFile(SUBMISSIONS_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

async function listSubmissions(filters) {
  if (supabase) {
    let query = supabase.from(SUPABASE_TABLE).select('*');

    if (filters.status && STATUS_OPTIONS.has(filters.status)) {
      query = query.eq('status', filters.status);
    }

    const sort = SORT_MAP[filters.sort] || SORT_MAP['created_at.desc'];
    query = query.order(sort.column, { ascending: sort.ascending, nullsFirst: false });

    const { data, error } = await query.limit(300);
    if (error) {
      throw new Error(`Supabase list failed: ${error.message}`);
    }

    return filterSearchResults((data || []).map(mapSubmissionRecord), filters.search);
  }

  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  const mapped = current.map(mapSubmissionRecord);
  const filtered = filters.status ? mapped.filter((item) => item.status === filters.status) : mapped;
  return sortSubmissions(filterSearchResults(filtered, filters.search), filters.sort);
}

async function updateSubmission(submissionId, payload) {
  if (supabase) {
    const updateRow = {
      status: payload.status,
      notes: payload.notes || null,
      assigned_to: payload.assignedTo,
      follow_up_at: payload.followUpAt,
      last_contacted_at: payload.lastContactedAt,
    };

    const { data, error } = await supabase
      .from(SUPABASE_TABLE)
      .update(updateRow)
      .eq('submission_id', submissionId)
      .select('*')
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase update failed: ${error.message}`);
    }

    if (!data) {
      throw new Error('NOT_FOUND');
    }

    return mapSubmissionRecord(data);
  }

  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  const index = current.findIndex((item) => item.id === submissionId || item.submission_id === submissionId);
  if (index < 0) {
    throw new Error('NOT_FOUND');
  }

  current[index] = {
    ...current[index],
    status: payload.status,
    notes: payload.notes || '',
    assignedTo: payload.assignedTo,
    followUpAt: payload.followUpAt,
    lastContactedAt: payload.lastContactedAt,
  };

  await fsp.writeFile(SUBMISSIONS_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  return mapSubmissionRecord(current[index]);
}

async function deleteSubmission(submissionId) {
  if (supabase) {
    const { data, error } = await supabase
      .from(SUPABASE_TABLE)
      .delete()
      .eq('submission_id', submissionId)
      .select('pdf_url')
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase delete failed: ${error.message}`);
    }

    if (!data) {
      throw new Error('NOT_FOUND');
    }

    await deletePdfAsset(data.pdf_url || null);
    return;
  }

  const current = JSON.parse(await fsp.readFile(SUBMISSIONS_FILE, 'utf8'));
  const index = current.findIndex((item) => item.id === submissionId || item.submission_id === submissionId);
  if (index < 0) {
    throw new Error('NOT_FOUND');
  }

  const [removed] = current.splice(index, 1);
  await fsp.writeFile(SUBMISSIONS_FILE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  await deletePdfAsset(removed.pdfUrl || removed.pdf_url || null);
}

async function createSubmissionPdfBuffer(submission) {
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];

    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

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
  });
}

async function persistSubmissionPdf(submission) {
  const pdfBuffer = await createSubmissionPdfBuffer(submission);
  const pdfFilename = `${submission.id}.pdf`;

  if (shouldUseSupabaseStorage()) {
    const storagePath = `solicitudes/${pdfFilename}`;
    const { error } = await supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .upload(storagePath, pdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    if (error) {
      throw new Error(`Supabase storage upload failed: ${error.message}`);
    }

    const publicUrl = supabase.storage
      .from(SUPABASE_STORAGE_BUCKET)
      .getPublicUrl(storagePath)
      .data
      .publicUrl;

    return {
      pdfFilename,
      pdfBuffer,
      pdfPath: storagePath,
      pdfUrl: publicUrl,
      emailAttachment: {
        filename: pdfFilename,
        content: pdfBuffer,
      },
    };
  }

  if (IS_VERCEL) {
    return {
      pdfFilename,
      pdfBuffer,
      pdfPath: null,
      pdfUrl: null,
      emailAttachment: {
        filename: pdfFilename,
        content: pdfBuffer,
      },
    };
  }

  await ensureStorage();
  const outputPath = path.join(PDF_DIR, pdfFilename);
  await fsp.writeFile(outputPath, pdfBuffer);

  return {
    pdfFilename,
    pdfBuffer,
    pdfPath: outputPath,
    pdfUrl: `/data/pdfs/${pdfFilename}`,
    emailAttachment: {
      filename: pdfFilename,
      path: outputPath,
    },
  };
}

async function deletePdfAsset(pdfUrl) {
  if (!pdfUrl) return;

  if (shouldUseSupabaseStorage()) {
    try {
      const storagePrefix = `/storage/v1/object/public/${SUPABASE_STORAGE_BUCKET}/`;
      const url = new URL(pdfUrl);
      const markerIndex = url.pathname.indexOf(storagePrefix);
      if (markerIndex >= 0) {
        const storagePath = decodeURIComponent(url.pathname.slice(markerIndex + storagePrefix.length));
        const { error } = await supabase.storage.from(SUPABASE_STORAGE_BUCKET).remove([storagePath]);
        if (error) {
          console.error('Error al eliminar PDF en storage:', error);
        }
      }
    } catch (error) {
      console.error('Error al resolver URL de PDF:', error);
    }
    return;
  }

  if (pdfUrl.startsWith('/data/pdfs/')) {
    const filename = pdfUrl.split('/').pop();
    if (!filename) return;
    const localPath = path.join(PDF_DIR, filename);
    try {
      await fsp.unlink(localPath);
    } catch {
      return;
    }
  }
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

async function sendNotificationEmail(submission, attachment) {
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
    attachments: attachment ? [attachment] : [],
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

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    return null;
  }

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function shouldUseSupabaseStorage() {
  return Boolean(supabase && SUPABASE_STORAGE_BUCKET);
}

function buildSupabaseRow(submission) {
  return {
    submission_id: submission.id,
    created_at: submission.createdAt,
    nombre: submission.nombre,
    municipio: submission.municipio,
    telefono: submission.telefono,
    maquina: submission.maquina,
    capacidad: submission.capacidad,
    tipo: submission.tipo,
    red: submission.red || null,
    fuente: submission.fuente || null,
    experiencia: submission.experiencia || null,
    score: submission.score,
    qualifies_for_direct_whatsapp: submission.qualifiesForDirectWhatsapp,
    pdf_url: submission.pdfUrl || null,
    status: submission.status || 'nuevo',
    notes: submission.notes || null,
    assigned_to: submission.assignedTo || null,
    follow_up_at: submission.followUpAt || null,
    last_contacted_at: submission.lastContactedAt || null,
  };
}

function mapSubmissionRecord(record) {
  return {
    id: record.id || record.submission_id,
    submission_id: record.submission_id || record.id,
    created_at: record.created_at || record.createdAt,
    nombre: record.nombre,
    municipio: record.municipio,
    telefono: record.telefono,
    maquina: record.maquina,
    capacidad: record.capacidad,
    tipo: Array.isArray(record.tipo) ? record.tipo : [],
    red: record.red || '',
    fuente: record.fuente || '',
    experiencia: record.experiencia || '',
    score: record.score || 0,
    qualifies_for_direct_whatsapp: Boolean(record.qualifies_for_direct_whatsapp ?? record.qualifiesForDirectWhatsapp),
    pdf_url: record.pdf_url || record.pdfUrl || null,
    status: record.status || 'nuevo',
    notes: record.notes || '',
    assigned_to: record.assigned_to || record.assignedTo || null,
    follow_up_at: record.follow_up_at || record.followUpAt || null,
    last_contacted_at: record.last_contacted_at || record.lastContactedAt || null,
  };
}

function filterSearchResults(items, search) {
  if (!search) return items;

  const term = search.toLowerCase();
  return items.filter((item) => {
    const haystack = [
      item.submission_id,
      item.nombre,
      item.municipio,
      item.telefono,
      item.assigned_to,
      item.notes,
    ].join(' ').toLowerCase();

    return haystack.includes(term);
  });
}

function sortSubmissions(items, sortKey) {
  const sort = SORT_MAP[sortKey] || SORT_MAP['created_at.desc'];
  return [...items].sort((a, b) => compareValues(a[sort.column], b[sort.column], sort.ascending));
}

function compareValues(a, b, ascending) {
  const left = a ?? null;
  const right = b ?? null;

  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;

  const leftValue = typeof left === 'string' && !Number.isNaN(Date.parse(left)) ? Date.parse(left) : left;
  const rightValue = typeof right === 'string' && !Number.isNaN(Date.parse(right)) ? Date.parse(right) : right;

  if (leftValue < rightValue) return ascending ? -1 : 1;
  return ascending ? 1 : -1;
}

function summarizeStatuses(items) {
  return items.reduce((acc, item) => {
    const key = item.status || 'nuevo';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeDateValue(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? 'invalid-date' : parsed.toISOString();
}

function requireAdminPageAccess(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  res.sendFile(ADMIN_HTML_FILE);
}

function requireAdminApiAuth(req, res, next) {
  if (isAuthenticated(req)) {
    return next();
  }

  res.status(401).json({
    ok: false,
    message: 'Sesión no autorizada.',
  });
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies[SESSION_COOKIE];
  if (!token) return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [payloadB64, signature] = parts;
  const expected = signValue(payloadB64);
  if (!safeEqual(signature, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (payload.username !== ADMIN_USERNAME) return false;
    if (Date.now() > payload.expiresAt) return false;
    return true;
  } catch {
    return false;
  }
}

function setSessionCookie(res, username) {
  const payloadB64 = Buffer.from(JSON.stringify({
    username,
    expiresAt: Date.now() + (1000 * 60 * 60 * 12),
  })).toString('base64url');
  const token = `${payloadB64}.${signValue(payloadB64)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=43200${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function parseCookies(headerValue) {
  return headerValue.split(';').reduce((acc, item) => {
    const trimmed = item.trim();
    if (!trimmed) return acc;
    const separator = trimmed.indexOf('=');
    const key = separator >= 0 ? trimmed.slice(0, separator) : trimmed;
    const value = separator >= 0 ? trimmed.slice(separator + 1) : '';
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function signValue(value) {
  return crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(value)
    .digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

if (require.main === module) {
  app.listen(PORT, async () => {
    await ensureStorage();
    console.log(`Servidor activo en http://localhost:${PORT}`);
  });
}

module.exports = app;

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
