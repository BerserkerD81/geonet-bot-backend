import { AppDataSource } from '../datasource';
import { SmartoltZone } from '../models/SmartoltZone';
import { SmartoltOdb } from '../models/SmartoltOdb';
import { getOdbs, getZones } from './smartoltClient';

export async function refreshZoneOdbCache() {
  const zoneRepo = AppDataSource.getRepository(SmartoltZone);
  const odbRepo = AppDataSource.getRepository(SmartoltOdb);
  const collectedAt = new Date();
  
  // Normalizador para comparar nombres ignorando mayúsculas/espacios
  const normalize = (v: string) => (v || '').toString().trim().toLowerCase();

  try {
    console.log('🔄 Sincronizando SmartOLT (Zonas y ODBs)...');

    // =================================================================
    // PASO 1: Obtener y Guardar ZONAS
    // =================================================================
    console.log('📡 Descargando Zonas...');
    const rawZones = await getZones().catch(e => { console.error('Error Zones:', e); return null; });

    if (!rawZones || rawZones.length === 0) {
      console.warn('⚠️ Lista de zonas vacía. Abortando.');
      return;
    }

    const existingZones = await zoneRepo.find();
    const zoneByExtId = new Map<string, SmartoltZone>();
    const zoneByName = new Map<string, SmartoltZone>();

    existingZones.forEach(z => {
      if (z.externalId) zoneByExtId.set(String(z.externalId), z);
      zoneByName.set(normalize(z.name), z);
    });

    const zonesToSave: SmartoltZone[] = [];

    // Procesamos el JSON de Zonas que me mostraste: {"id":"48", "name":"..."}
    rawZones.forEach((z: any) => {
      const extId = z.id ? String(z.id).trim() : null; // "48"
      const name = (z.name || z.id || '').toString().trim();
      
      if (!name) return;

      let zone = extId ? zoneByExtId.get(extId) : null;
      if (!zone) zone = zoneByName.get(normalize(name));

      if (zone) {
        zone.name = name;
        zone.collectedAt = collectedAt;
        if (extId) zone.externalId = extId;
      } else {
        zone = zoneRepo.create({
          name: name,
          externalId: extId,
          collectedAt: collectedAt
        });
      }
      zonesToSave.push(zone);
    });

    const savedZones = await zoneRepo.save(zonesToSave);
    console.log(`✅ ${savedZones.length} Zonas sincronizadas.`);

    // =================================================================
    // PASO 2: Obtener y Guardar ODBs
    // =================================================================
    console.log('📡 Descargando ODBs...');
    const rawOdbs = await getOdbs().catch(e => { console.error('Error ODBs:', e); return null; });

    if (!rawOdbs || rawOdbs.length === 0) {
      console.warn('⚠️ Lista de ODBs vacía.');
      return;
    }

    // Actualizamos mapas con las zonas recién guardadas
    zoneByExtId.clear();
    zoneByName.clear();
    savedZones.forEach(z => {
      if (z.externalId) zoneByExtId.set(String(z.externalId), z);
      zoneByName.set(normalize(z.name), z);
    });

    // Limpieza de ODBs previos en las zonas afectadas
    const zoneIds = savedZones.map(z => z.id);
    if (zoneIds.length > 0) {
      await odbRepo.createQueryBuilder()
        .delete()
        .where("zone_id IN (:...ids)", { ids: zoneIds })
        .execute();
    }

    const odbsToSave: SmartoltOdb[] = [];
    let orphanCount = 0;

    // Procesamos el JSON de ODBs: {"id":"89", "nr_of_ports":"16", "zone_id":"46", ...}
    rawOdbs.forEach((o: any) => {
      const odbName = (o.name || o.id || '').toString().trim();
      const odbExtId = o.id ? String(o.id) : null;
      const targetZoneId = o.zone_id ? String(o.zone_id).trim() : null; // "46"
      
      if (!odbName) return;

      // Buscamos la zona padre
      let linkedZone = targetZoneId ? zoneByExtId.get(targetZoneId) : null;
      
      if (!linkedZone && o.zone_name) {
        linkedZone = zoneByName.get(normalize(o.zone_name));
      }

      if (linkedZone) {
        odbsToSave.push(odbRepo.create({
          name: odbName,
          externalId: odbExtId,
          // Mapeo exacto de los campos de tu API
          ports: o.nr_of_ports ? parseInt(o.nr_of_ports, 10) : null,
          latitude: o.latitude ? String(o.latitude) : null,
          longitude: o.longitude ? String(o.longitude) : null,
          collectedAt: collectedAt,
          zone: linkedZone
        }));
      } else {
        orphanCount++;
        // Solo logueamos si es crítico (opcional)
        // console.warn(`Huérfano: ${odbName} (ZoneID: ${targetZoneId})`);
      }
    });

    if (odbsToSave.length > 0) {
      await odbRepo.save(odbsToSave);
      console.log(`✅ ${odbsToSave.length} ODBs sincronizadas.`);
    }
    
    if (orphanCount > 0) {
      console.log(`ℹ️ ${orphanCount} ODBs ignoradas por falta de zona.`);
    }

    console.log('🎉 Proceso finalizado.');

  } catch (error) {
    console.error('❌ Error crítico en sync:', error);
  }
}