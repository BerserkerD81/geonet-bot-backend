import { AppDataSource } from '../datasource';
import { WizardSession, WizardStepLog } from '../models/WizardSession';
import { User } from '../models/User';

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function resolveIsAdmin(req: any): Promise<boolean> {
  try {
    const uid = Number(req.session?.userId);
    if (!uid) return false;
    const repo = AppDataSource.getRepository(User);
    const user = await repo.findOne({ where: { id: uid } });
    return user?.role === 'admin';
  } catch { return false; }
}

// POST /wizard/sessions
export async function createWizardSession(req: any, res: any) {
  try {
    const { type } = req.body || {};
    if (!type) return res.status(400).json({ ok: false, error: 'type requerido' });

    const userId = Number(req.session?.userId);
    if (!userId) return res.status(401).json({ ok: false, error: 'unauthenticated' });

    const userRepo = AppDataSource.getRepository(User);
    const user = await userRepo.findOne({ where: { id: userId } });

    const id = randomId();
    const repo = AppDataSource.getRepository(WizardSession);
    const session = repo.create({
      id,
      userId,
      userName: user?.name || user?.email || String(userId),
      type,
      status: 'in-progress',
      stepsJson: '[]',
    });
    await repo.save(session);

    return res.json({ ok: true, id });
  } catch (e: any) {
    console.error('[wizardSession] create error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /wizard/sessions/:id/step
export async function logWizardStep(req: any, res: any) {
  try {
    const { id } = req.params;
    const { stepName, stepLabel, status, inputData, outputData, errorMsg, resumeData, clientId, clientName } = req.body || {};

    const repo = AppDataSource.getRepository(WizardSession);
    const session = await repo.findOne({ where: { id } });
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const step: WizardStepLog = {
      stepName: stepName || 'step',
      stepLabel: stepLabel || stepName || 'Paso',
      status: status || 'ok',
      timestamp: new Date().toISOString(),
      ...(inputData ? { inputData } : {}),
      ...(outputData ? { outputData } : {}),
      ...(errorMsg ? { errorMsg } : {}),
    };

    const existingSteps = session.steps;
    const newSteps = [...existingSteps, step];

    const updates: Partial<WizardSession> = {
      stepsJson: JSON.stringify(newSteps),
      updatedAt: new Date(),
    };

    if (clientId) updates.clientId = Number(clientId);
    if (clientName) updates.clientName = String(clientName);
    if (resumeData) updates.resumeDataJson = JSON.stringify(resumeData);

    await repo.update({ id }, updates);
    return res.json({ ok: true });
  } catch (e: any) {
    console.error('[wizardSession] logStep error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /wizard/sessions/:id/resume-data
export async function updateWizardResumeData(req: any, res: any) {
  try {
    const { id } = req.params;
    const { resumeData, clientId, clientName } = req.body || {};

    const repo = AppDataSource.getRepository(WizardSession);
    const updates: Partial<WizardSession> = { updatedAt: new Date() };
    if (resumeData !== undefined) updates.resumeDataJson = JSON.stringify(resumeData);
    if (clientId) updates.clientId = Number(clientId);
    if (clientName) updates.clientName = String(clientName);
    await repo.update({ id }, updates);
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /wizard/sessions/:id/complete
export async function completeWizardSession(req: any, res: any) {
  try {
    const { id } = req.params;
    const { summary } = req.body || {};

    const repo = AppDataSource.getRepository(WizardSession);
    await repo.update({ id }, {
      status: 'completed',
      summary: summary ? String(summary).slice(0, 499) : undefined,
      completedAt: new Date(),
      updatedAt: new Date(),
      resumeDataJson: undefined, // clear resume data once complete
    });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// PATCH /wizard/sessions/:id/fail
export async function failWizardSession(req: any, res: any) {
  try {
    const { id } = req.params;
    const { errorMsg } = req.body || {};

    const repo = AppDataSource.getRepository(WizardSession);
    await repo.update({ id }, {
      status: 'failed',
      errorMsg: errorMsg ? String(errorMsg).slice(0, 499) : undefined,
      updatedAt: new Date(),
    });
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// POST /wizard/sessions/:id/abandon  (POST so sendBeacon can hit it)
export async function abandonWizardSession(req: any, res: any) {
  try {
    const { id } = req.params;
    const repo = AppDataSource.getRepository(WizardSession);
    const session = await repo.findOne({ where: { id } });
    if (session?.status === 'in-progress') {
      await repo.update({ id }, { status: 'abandoned', updatedAt: new Date() });
    }
    return res.json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /wizard/sessions — list (own for users, all for admins)
export async function listWizardSessions(req: any, res: any) {
  try {
    const userId = Number(req.session?.userId);
    const isAdmin = await resolveIsAdmin(req);
    const { limit = 60, type, status } = req.query as any;

    const repo = AppDataSource.getRepository(WizardSession);
    let qb = repo.createQueryBuilder('s')
      .select(['s.id', 's.userId', 's.userName', 's.type', 's.status', 's.clientId', 's.clientName', 's.summary', 's.errorMsg', 's.startedAt', 's.updatedAt', 's.completedAt'])
      .orderBy('s.startedAt', 'DESC')
      .take(Math.min(Number(limit) || 60, 200));

    if (!isAdmin) qb = qb.andWhere('s.userId = :userId', { userId });
    if (type) qb = qb.andWhere('s.type = :type', { type });
    if (status) qb = qb.andWhere('s.status = :status', { status });

    const sessions = await qb.getMany();
    return res.json({ ok: true, sessions, isAdmin });
  } catch (e: any) {
    console.error('[wizardSession] list error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /wizard/sessions/search — search with text query (own for users, all for admins)
export async function searchWizardSessions(req: any, res: any) {
  try {
    const userId = Number(req.session?.userId);
    const isAdmin = await resolveIsAdmin(req);
    const { q = '', limit = 40, type, status } = req.query as any;

    const repo = AppDataSource.getRepository(WizardSession);
    let qb = repo.createQueryBuilder('s')
      .select(['s.id', 's.userId', 's.userName', 's.type', 's.status', 's.clientId', 's.clientName', 's.summary', 's.errorMsg', 's.startedAt', 's.updatedAt', 's.completedAt'])
      .orderBy('s.startedAt', 'DESC')
      .take(Math.min(Number(limit) || 40, 100));

    if (!isAdmin) qb = qb.andWhere('s.userId = :userId', { userId });
    if (type) qb = qb.andWhere('s.type = :type', { type });
    if (status) qb = qb.andWhere('s.status = :status', { status });

    if (q && q.trim()) {
      const searchTerm = `%${q.trim()}%`;
      qb = qb.andWhere(
        `(s.userName LIKE :term OR s.clientName LIKE :term OR s.summary LIKE :term OR s.type LIKE :term OR s.errorMsg LIKE :term)`,
        { term: searchTerm }
      );
    }

    const sessions = await qb.getMany();
    return res.json({ ok: true, sessions, isAdmin });
  } catch (e: any) {
    console.error('[wizardSession] search error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// GET /wizard/sessions/:id — detail (own or admin)
export async function getWizardSession(req: any, res: any) {
  try {
    const { id } = req.params;
    const userId = Number(req.session?.userId);
    const isAdmin = await resolveIsAdmin(req);

    const repo = AppDataSource.getRepository(WizardSession);
    const session = await repo.findOne({ where: { id } });
    if (!session) return res.status(404).json({ ok: false, error: 'No encontrado' });
    if (!isAdmin && session.userId !== userId) return res.status(403).json({ ok: false, error: 'Sin acceso' });

    return res.json({
      ok: true,
      session: {
        ...session,
        steps: session.steps,
        resumeData: session.resumeData,
        stepsJson: undefined,
        resumeDataJson: undefined,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
