import { Router } from 'express';
import { listClients, searchClients, syncAll } from '../controllers/clientsController';

const router = Router();

router.get('/', listClients);
router.get('/search', searchClients);
router.post('/sync', syncAll);

export default router;
