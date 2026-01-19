import express from 'express';
import * as controller from '../controllers/authController';
import { requireAuth, requirePendingOrAuthed, requireAdmin } from '../middlewares/auth';

const router = express.Router();

// Registration is admin-only
router.post('/register', requireAdmin, controller.register);
router.post('/login', controller.login);
router.post('/login/2fa', controller.login2fa);
router.post('/logout', controller.logout);
router.get('/me', controller.me);
router.post('/password/change', requireAuth, controller.changePassword);

router.post('/2fa/setup', requirePendingOrAuthed, controller.setup2fa);
router.post('/2fa/verify', requirePendingOrAuthed, controller.verify2fa);

export default router;
