import { AppDataSource } from '../datasource';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { SmartoltOlt } from '../models/SmartoltOlt';
import { SmartoltVlan } from '../models/SmartoltVlan';
import { getOdbs, getZones, listOlts, getOltVlans } from './smartoltClient';

/**
 * Fetch zones and ODBs from SmartOLT and store them in the cache tables.
 * - Upserts zonas usando el id externo de SmartOLT y el nombre (fallback), manteniendo IDs locales y collectedAt.
 * - Reemplaza ODBs por zona usando el zone_id que provee SmartOLT para ligarlas correctamente.
 */
export async function refreshZoneOdbCache() {
  const zoneRepo = AppDataSource.getRepository(SmartoltZone);
  const odbRepo = AppDataSource.getRepository(SmartoltOdb);
  const oltRepo = AppDataSource.getRepository(SmartoltOlt);
  const vlanRepo = AppDataSource.getRepository(SmartoltVlan);
  const collectedAt = new Date();
  const normalize = (v: string) => (v || '').toString().trim().toLowerCase();

  const [zones, odbs, olts] = await Promise.all([
    getZones().catch(() => []),
    getOdbs().catch(() => []),
    listOlts().catch(() => [])
  ]);

  // Upsert zonas basadas en externalId (preferente) y nombre como respaldo
  const existingZones = await zoneRepo.find();
  const zoneByExternalId = new Map<string, SmartoltZone>();
  const zoneByName = new Map<string, SmartoltZone>();
  existingZones.forEach((z) => {
    if (z.externalId) zoneByExternalId.set(z.externalId, z);
    zoneByName.set(normalize(z.name), z);
  });

  const toSaveZones: SmartoltZone[] = [];
  if (Array.isArray(zones)) {
    zones.forEach((z: any) => {
      const extId = z?.id ? String(z.id) : undefined;
      const name = (z?.name || z?.id || '').toString().trim();
      if (!name) return;

      let existing: SmartoltZone | undefined;
      if (extId) existing = zoneByExternalId.get(extId);
      if (!existing) existing = zoneByName.get(normalize(name));

      if (existing) {
        existing.name = name;
        existing.externalId = extId || existing.externalId || null;
        existing.collectedAt = collectedAt;
        toSaveZones.push(existing);
      } else {
        const created = zoneRepo.create({ name, externalId: extId || null, collectedAt });
        toSaveZones.push(created);
      }
    });
  }

  const savedZones = await zoneRepo.save(toSaveZones);
  zoneByExternalId.clear();
  zoneByName.clear();
  savedZones.forEach((z) => {
    if (z.externalId) zoneByExternalId.set(z.externalId, z);
    zoneByName.set(normalize(z.name), z);
  });

  // Remove existing ODBs for the zones we are about to repopulate to avoid duplicates
  const zoneIds = savedZones.map((z) => z.id);
  if (zoneIds.length) {
    await odbRepo
      .createQueryBuilder()
      .delete()
      .where('zone_id IN (:...zoneIds)', { zoneIds })
      .execute();
  }

  const odbEntities: SmartoltOdb[] = [];
  if (Array.isArray(odbs)) {
    odbs.forEach((o: any) => {
      const zoneName = (o?.zone || '').toString().trim();
      const zoneExtId = o?.zone_id || o?.zoneId || o?.zoneid;
      const odbName = (o?.name || o?.id || '').toString().trim();
      const odbId = o?.id ? String(o.id) : null;
      if (!odbName) return;
      let zone: SmartoltZone | undefined;
      if (zoneExtId) zone = zoneByExternalId.get(String(zoneExtId));
      if (!zone && zoneName) zone = zoneByName.get(normalize(zoneName));
      if (!zone) return;
      odbEntities.push(
        odbRepo.create({
          name: odbName,
          externalId: odbId,
          collectedAt,
          zone
        })
      );
    });
  }

  if (odbEntities.length) {
    await odbRepo.save(odbEntities);
  }

  // --- OLTs: upsert and save ---
  try {
    const existingOlts = await oltRepo.find();
    const oltByExternalId = new Map<string, SmartoltOlt>();
    const oltByName = new Map<string, SmartoltOlt>();
    existingOlts.forEach((o) => {
      if (o.externalId) oltByExternalId.set(o.externalId, o);
      oltByName.set(normalize(o.name), o);
    });

    const toSaveOlts: SmartoltOlt[] = [];
    if (Array.isArray(olts)) {
      olts.forEach((o: any) => {
        const extId = o?.id ? String(o.id) : undefined;
        const name = (o?.name || o?.id || o?.ip || '').toString().trim();
        if (!name) return;

        let existing: SmartoltOlt | undefined;
        if (extId) existing = oltByExternalId.get(extId);
        if (!existing) existing = oltByName.get(normalize(name));

        if (existing) {
          existing.name = name;
          existing.externalId = extId || existing.externalId || null;
          existing.collectedAt = collectedAt;
          toSaveOlts.push(existing);
        } else {
          const created = oltRepo.create({ name, externalId: extId || null, collectedAt });
          toSaveOlts.push(created);
        }
      });
    }

    const savedOlts = await oltRepo.save(toSaveOlts);

    // Remove existing VLANs for these OLTs before repopulating
    const oltIds = savedOlts.map((o) => o.id);
    if (oltIds.length) {
      await vlanRepo
        .createQueryBuilder()
        .delete()
        .where('olt_id IN (:...oltIds)', { oltIds })
        .execute();
    }

    // Fetch VLANs per saved OLT and create entities
    const vlanEntities: SmartoltVlan[] = [];
    await Promise.all(
      savedOlts.map(async (savedOlt) => {
        const oltExtId = savedOlt.externalId;
        if (!oltExtId) return;
        let vlans: Array<any> = [];
        try {
          vlans = await getOltVlans(oltExtId).catch(() => []);
        } catch (e) {
          // ignore per-OLT failure
          vlans = [];
        }
        if (!Array.isArray(vlans)) return;
        vlans.forEach((v) => {
          const vlanId = v?.vlan_id ?? v?.vlan ?? v?.id ?? v;
          const name = (v?.name || v?.description || v?.label || '').toString().trim();
          if (!vlanId) return;
          vlanEntities.push(
            vlanRepo.create({ externalId: String(vlanId), name: name || null, collectedAt, olt: savedOlt })
          );
        });
      })
    );

    if (vlanEntities.length) await vlanRepo.save(vlanEntities);
  } catch (err) {
    console.warn('refreshZoneOdbCache: OLT/VLAN refresh failed', (err as any)?.message || err);
  }
}
