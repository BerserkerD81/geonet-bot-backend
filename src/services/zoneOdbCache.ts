import { AppDataSource } from '../datasource';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { getOdbs, getZones } from './smartoltClient';

/**
 * Fetch zones and ODBs from SmartOLT and store them in the cache tables.
 * - Upserts zonas usando el id externo de SmartOLT y el nombre (fallback), manteniendo IDs locales y collectedAt.
 * - Reemplaza ODBs por zona usando el zone_id que provee SmartOLT para ligarlas correctamente.
 */
export async function refreshZoneOdbCache() {
  const zoneRepo = AppDataSource.getRepository(SmartoltZone);
  const odbRepo = AppDataSource.getRepository(SmartoltOdb);
  const collectedAt = new Date();
  const normalize = (v: string) => (v || '').toString().trim().toLowerCase();

  const [zones, odbs] = await Promise.all([getZones().catch(() => []), getOdbs().catch(() => [])]);

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
}
