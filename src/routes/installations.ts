import { Router } from 'express';
import { listInstallations, syncInstallations, listInstallationsFromWisphub } from '../controllers/installationsController';
import { getClientsForInstallation } from '../controllers/installationsController';
import { requireSystemOrAuth } from '../middlewares/auth';

const router = Router();

router.get('/', requireSystemOrAuth, listInstallations);
router.get('/wisphub', requireSystemOrAuth, listInstallationsFromWisphub);
router.get('/:id/clients', requireSystemOrAuth, getClientsForInstallation);
router.post('/sync', requireSystemOrAuth, syncInstallations);

export default router;
