import express from 'express';
import { requireAuth } from '../middlewares/auth';
import {
  getAuthWizardInstallations, prepareAuthWizard, getOdbsByZone, applyWifiWizard, activateWispHubWizard,
  searchChangeOnuClients, prepareChangeOnuWizard, submitChangeOnuWizard,
  prepareMonitorWizard, rebootMonitorWizard, resyncMonitorWizard,
  submitBajaWizard, uploadFotoWizard,
} from '../controllers/wizardController';
import {
  createWizardSession, logWizardStep, updateWizardResumeData,
  completeWizardSession, failWizardSession, abandonWizardSession,
  listWizardSessions, getWizardSession,
} from '../controllers/wizardSessionController';

const router = express.Router();

// Auth wizard
router.get('/auth/installations', requireAuth, getAuthWizardInstallations);
router.post('/auth/prepare', requireAuth, prepareAuthWizard);
router.get('/auth/odbs', requireAuth, getOdbsByZone);
router.post('/auth/wifi', requireAuth, applyWifiWizard);
router.post('/auth/activate', requireAuth, activateWispHubWizard);

// Change ONU wizard
router.post('/change-onu/search', requireAuth, searchChangeOnuClients);
router.post('/change-onu/prepare', requireAuth, prepareChangeOnuWizard);
router.post('/change-onu/submit', requireAuth, submitChangeOnuWizard);

// Monitor wizard
router.post('/monitor/prepare', requireAuth, prepareMonitorWizard);
router.post('/monitor/reboot', requireAuth, rebootMonitorWizard);
router.post('/monitor/resync', requireAuth, resyncMonitorWizard);

// Baja cliente wizard
router.post('/baja/submit', requireAuth, submitBajaWizard);

// Fotos wizard
router.post('/fotos/upload', requireAuth, uploadFotoWizard);

// Wizard sessions (historial)
router.post('/sessions', requireAuth, createWizardSession);
router.patch('/sessions/:id/step', requireAuth, logWizardStep);
router.patch('/sessions/:id/resume-data', requireAuth, updateWizardResumeData);
router.patch('/sessions/:id/complete', requireAuth, completeWizardSession);
router.patch('/sessions/:id/fail', requireAuth, failWizardSession);
router.post('/sessions/:id/abandon', requireAuth, abandonWizardSession);
router.get('/sessions', requireAuth, listWizardSessions);
router.get('/sessions/:id', requireAuth, getWizardSession);

export default router;
