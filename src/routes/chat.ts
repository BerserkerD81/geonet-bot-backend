import express from 'express';
import { requireAuth } from '../middlewares/auth';
import { addMessage, respond, submitAuth, applyPendingWan, getUserChats } from '../controllers/chatController';
import { authenticateGeonet, downloadContratoGeonet } from '../services/wisphubClient';

const router = express.Router();

// --- Rutas del Chat ---
router.get('/history', requireAuth, getUserChats); // <--- NUEVA RUTA
router.post('/messages', requireAuth, addMessage);
router.post('/respond', requireAuth, respond);
router.post('/submitAuth', requireAuth, submitAuth);
router.post('/applyPendingWan', requireAuth, applyPendingWan);

// --- Ruta de Descarga ---
// Nota: Esta ruta será accesible como /chat/downloads/contract/:id
router.get('/downloads/contract/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Validar autenticación básica si es necesario, o confiar en que el ID es difícil de adivinar
    // Si quieres máxima seguridad, podrías verificar req.session.userId aquí también

    const isAuthenticated = await authenticateGeonet();
    
    if (!isAuthenticated) {
      return res.status(502).send('Error: No se pudo conectar con Geonet.');
    }

    const pdfBuffer = await downloadContratoGeonet(id);

    // CONFIGURACIÓN CLAVE PARA DESCARGA DIRECTA
    res.setHeader('Content-Type', 'application/pdf');
    // 'attachment' fuerza la descarga. Si pusieras 'inline', se intentaría abrir en el navegador.
    res.setHeader('Content-Disposition', `attachment; filename="Contrato_Cliente_${id}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);

    res.end(pdfBuffer); // Usar end() con buffer a veces es más limpio que send() para binarios

  } catch (error) {
    console.error(`Error contrato ${id}:`, error);
    // Si falla, enviamos texto plano para que no intente descargar un error como PDF
    res.status(500).setHeader('Content-Type', 'text/plain');
    res.send('Error interno al descargar el contrato.');
  }
});

export default router;