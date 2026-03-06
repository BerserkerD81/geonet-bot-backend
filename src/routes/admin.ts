import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import * as adminUsers from '../controllers/adminUserController';
import { listUserMessages, listAdminUserSessions, getAdminUserSessionMessages } from '../controllers/chatController';

const router = express.Router();

router.use(requireAdmin);

router.get('/users', adminUsers.listUsers);
router.post('/users', adminUsers.createUser);
router.patch('/users/:id', adminUsers.updateUser);
router.delete('/users/:id', adminUsers.deleteUser);

// Chat history per user (admin only)
router.get('/users/:userId/messages', listUserMessages);
router.get('/users/:userId/sessions', listAdminUserSessions);
router.get('/users/:userId/sessions/:sessionId/messages', getAdminUserSessionMessages);

export default router;
