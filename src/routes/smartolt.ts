import { Router } from 'express';
import {
	authorize,
	getCustomer,
	getInstallation,
	getOnu,
	listUnconfiguredOnus,
	getService,
	listOdbsByZone
} from '../controllers/smartoltController';
import { requireSystemOrAuth } from '../middlewares/auth';
const router = Router();
// Update the import path if the file is named differently or located elsewhere
// For example, if the file is named 'auth.middleware.ts' in the same folder:

// Or, if the file does not exist, create it with the following content:

// /home/jorge/projects/geonet-bot-backend/src/middlewares/authMiddleware.ts
// export function requireSystemOrAuth(req, res, next) {
//   // Your middleware logic here
//   next();
// }

router.post('/authorize', requireSystemOrAuth, authorize); // legacy path
router.post('/authorizations', requireSystemOrAuth, authorize); // preferred path for final authorization
router.get('/onus/:serial', requireSystemOrAuth, getOnu);
router.get('/unconfigured', requireSystemOrAuth, listUnconfiguredOnus);
router.get('/customers/:id', requireSystemOrAuth, getCustomer);
router.get('/services/:id', requireSystemOrAuth, getService);
router.get('/installations/:id', requireSystemOrAuth, getInstallation);
router.get('/zones/:zone/odbs', requireSystemOrAuth, listOdbsByZone);

export default router;
