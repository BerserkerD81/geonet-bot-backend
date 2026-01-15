import express from 'express';
import { requireAuth } from '../middlewares/auth';
import { addMessage } from '../controllers/chatController';

const router = express.Router();

router.post('/messages', requireAuth, addMessage);

export default router;
