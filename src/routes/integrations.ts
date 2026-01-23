import { Router } from 'express';
import { getStatus } from '../controllers/integrationsController';

const router = Router();

router.get('/status', getStatus);

export default router;
