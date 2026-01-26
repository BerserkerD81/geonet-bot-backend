import { Router } from 'express';
import { listClients, searchClients, syncAll, listClientsFromWisphub } from '../controllers/clientsController';
import { requireSystemOrAuth } from '../middlewares/auth';

const router = Router();

router.get('/', requireSystemOrAuth, listClients);
router.get('/wisphub', requireSystemOrAuth, listClientsFromWisphub);
router.get('/search', requireSystemOrAuth, searchClients);
router.post('/sync', requireSystemOrAuth, syncAll);

export default router;
