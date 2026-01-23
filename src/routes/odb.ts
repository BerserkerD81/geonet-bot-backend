import { Router } from 'express';
import { getOdbAvailablePorts } from '../controllers/odbController';

const router = Router();

// GET /odbs/:externalId/ports - fetch available ports for an ODB by externalId
router.get('/odbs/:externalId/ports', getOdbAvailablePorts);

export default router;
