import { Router } from 'express';
import {
	authorize,
	getCustomer,
	getInstallation,
	getOnu,
	getService,
	listOdbsByZone
} from '../controllers/smartoltController';

const router = Router();

router.post('/authorize', authorize); // legacy path
router.post('/authorizations', authorize); // preferred path for final authorization
router.get('/onus/:serial', getOnu);
router.get('/customers/:id', getCustomer);
router.get('/services/:id', getService);
router.get('/installations/:id', getInstallation);
router.get('/zones/:zone/odbs', listOdbsByZone);

export default router;
