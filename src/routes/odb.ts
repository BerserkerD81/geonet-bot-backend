import { Router } from 'express';
import { getOdbAvailablePorts } from '../controllers/odbController';
import { requireSystemOrAuth } from '../middlewares/auth';

const router = Router();

// GET /odbs/:externalId/ports - fetch available ports for an ODB by externalId
router.get('/odbs/:externalId/ports', requireSystemOrAuth, getOdbAvailablePorts);

export default router;
