import { Router } from 'express';
import { listInstallations, syncInstallations } from '../controllers/installationsController';

const router = Router();

router.get('/', listInstallations);
router.post('/sync', syncInstallations);

export default router;
