import { Router } from 'express';
import { getStatus } from '../controllers/integrationsController';
import { requireSystemOrAuth } from '../middlewares/auth';

const router = Router();

router.get('/status', requireSystemOrAuth, getStatus);

export default router;
