import express from 'express';
import { requireAdmin } from '../middlewares/auth';
import * as adminUsers from '../controllers/adminUserController';
import { listUserMessages } from '../controllers/chatStorageController';

const router = express.Router();

router.use(requireAdmin);

router.get('/users', adminUsers.listUsers);
router.post('/users', adminUsers.createUser);
router.patch('/users/:id', adminUsers.updateUser);
router.delete('/users/:id', adminUsers.deleteUser);

// Chat history per user (admin only)
router.get('/users/:userId/messages', listUserMessages);

export default router;
