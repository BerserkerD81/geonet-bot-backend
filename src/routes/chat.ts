import express from 'express';
import { requireAuth } from '../middlewares/auth';
import { addMessage, respond, submitAuth, applyPendingWan } from '../controllers/chatController';

const router = express.Router();

router.post('/messages', requireAuth, addMessage);
router.post('/respond', requireAuth, respond);
router.post('/submitAuth', requireAuth, submitAuth);
router.post('/applyPendingWan', requireAuth, applyPendingWan);

export default router;
