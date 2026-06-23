import express, { Request, Response } from 'express';
import { liberarWifiProductBySn, editarClienteWifiProductBySn } from '../services/wisphubClient';

const router = express.Router();

/**
 * GET /test
 * Instrucciones de uso.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    rutas: [
      {
        metodo: 'POST',
        ruta: '/test/liberar-equipo',
        body: { sn: 'NUMERO_DE_SERIE' },
        ejemplo_curl: `curl -X POST http://localhost:3000/test/liberar-equipo -H "Content-Type: application/json" -d '{"sn":"HWTC1234ABCD"}'`,
      },
      {
        metodo: 'POST',
        ruta: '/test/asignar-equipo-fallback',
        body: { sn: 'NUMERO_DE_SERIE', usuario: 'USERNAME_CLIENTE' },
        ejemplo_curl: `curl -X POST http://localhost:3000/test/asignar-equipo-fallback -H "Content-Type: application/json" -d '{"sn":"HWTC4411D540","usuario":"1707_jorge"}'`,
      },
    ],
  });
});

/**
 * POST /test/liberar-equipo
 * Body: { "sn": "HWTC1234ABCD" }
 *
 * Busca el equipo en WispHub por número de serie y lo libera.
 */
router.post('/liberar-equipo', async (req: Request, res: Response) => {
  const { sn } = req.body as { sn?: string };

  if (!sn || !String(sn).trim()) {
    return res.status(400).json({
      ok: false,
      error: 'Se requiere el campo "sn" (número de serie) en el body',
      ejemplo: { sn: 'HWTC1234ABCD' },
    });
  }

  const serial = String(sn).trim().toUpperCase();
  console.log(`[TEST /liberar-equipo] sn="${serial}"`);
  const start = Date.now();

  const result = await liberarWifiProductBySn(serial);
  const elapsed = Date.now() - start;

  return res.status(result.ok ? 200 : 422).json({
    ok: result.ok,
    elapsed_ms: elapsed,
    sn: serial,
    uuid: result.uuid ?? null,
    cliente: result.cliente ?? null,
    nota: result.note ?? null,
    error: result.error ?? null,
  });
});

/**
 * POST /test/asignar-equipo-fallback
 * Body: { "sn": "HWTC4411D540", "usuario": "1707_jorge" }
 *
 * Busca el equipo en /productos-wifi/ por SN, navega a editar/{uuid}/
 * y cambia lista_servicios al usuario indicado.
 */
router.post('/asignar-equipo-fallback', async (req: Request, res: Response) => {
  const { sn, usuario } = req.body as { sn?: string; usuario?: string };

  if (!sn || !String(sn).trim()) {
    return res.status(400).json({ ok: false, error: 'Se requiere "sn" (número de serie)' });
  }
  if (!usuario || !String(usuario).trim()) {
    return res.status(400).json({ ok: false, error: 'Se requiere "usuario" (username del cliente en Geonet)' });
  }

  const serial = String(sn).trim().toUpperCase();
  const user = String(usuario).trim();
  console.log(`[TEST /asignar-equipo-fallback] sn="${serial}" usuario="${user}"`);
  const start = Date.now();

  const ok = await editarClienteWifiProductBySn(serial, user);
  const elapsed = Date.now() - start;

  return res.status(ok ? 200 : 422).json({
    ok,
    elapsed_ms: elapsed,
    sn: serial,
    usuario: user,
  });
});

export default router;
