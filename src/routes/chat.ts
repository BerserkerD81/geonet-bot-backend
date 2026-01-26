import express from 'express';
import { requireSystemOrAuth } from '../middlewares/auth';
import { submitAuth, applyPendingWan, initiateAuth, initiateWan, listClientsByNameActions } from '../controllers/formsController';

import { saveMessage } from '../controllers/chatStorageController';
import { handleChatMessage } from '../controllers/chatController';

const router = express.Router();

router.post('/submitAuth', requireSystemOrAuth, submitAuth);
router.post('/applyPendingWan', requireSystemOrAuth, applyPendingWan);
router.post('/auth/initiate', requireSystemOrAuth, initiateAuth);
router.post('/wan/initiate', requireSystemOrAuth, initiateWan);
router.post('/save', saveMessage);
router.post('/message', requireSystemOrAuth, handleChatMessage);
router.get('/clients/actions', requireSystemOrAuth, listClientsByNameActions);

export default router;
