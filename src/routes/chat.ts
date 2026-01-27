import express from 'express';
<<<<<<< HEAD
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
=======
import { requireAuth } from '../middlewares/auth';
import { addMessage } from '../controllers/chatController';

const router = express.Router();

router.post('/messages', requireAuth, addMessage);
>>>>>>> parent of d0c9887 (feat: add Wisphub client and installation services with full sync capabilities)

export default router;
