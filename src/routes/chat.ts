import express from 'express';
import { requireAuth } from '../middlewares/auth';
import { 
    addMessage, 
    respond, 
    submitAuth, 
    applyPendingWan, 
    getUserSessions, 
    getSessionMessages,
  searchUserMessages,
  deleteUserSession,
  deleteUserMessage
} from '../controllers/chatController';
import { authenticateGeonet, downloadContratoGeonet } from '../services/wisphubClient';

const router = express.Router();

// --- Rutas del Chat Actualizadas ---
router.get('/search', requireAuth, searchUserMessages); // <--- 2. AGREGAR ESTA RUTA
router.get('/sessions', requireAuth, getUserSessions); 
router.get('/sessions/:sessionId/messages', requireAuth, getSessionMessages);
router.delete('/sessions/:sessionId', requireAuth, deleteUserSession);
router.delete('/messages/:messageId', requireAuth, deleteUserMessage);

// --- Rutas de Interacción ---
router.post('/messages', requireAuth, addMessage);
router.post('/respond', requireAuth, respond);
router.post('/submitAuth', requireAuth, submitAuth);
router.post('/applyPendingWan', requireAuth, applyPendingWan);

// --- Ruta de Descarga ---
router.get('/downloads/contract/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const isAuthenticated = await authenticateGeonet();
    if (!isAuthenticated) return res.status(502).send('Error: No se pudo conectar con Geonet.');

    const pdfBuffer = await downloadContratoGeonet(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Contrato_Cliente_${id}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  } catch (error) {
    console.error(`Error contrato ${id}:`, error);
    res.status(500).setHeader('Content-Type', 'text/plain');
    res.send('Error interno al descargar el contrato.');
  }
});

export default router;