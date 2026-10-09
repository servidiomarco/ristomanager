import { describe, it, expect, afterAll } from 'vitest';
import pool, { runWithTenantContext } from '../../db';
import { RolePermissionService } from '../../auth/permissionService';
import { UserRole } from '../../types';

// La cache dei permessi vive nel processo che la importa: qui è quella di
// QUESTO worker, vuota come quella di un server appena avviato.
describe('cache dei permessi', () => {
    afterAll(async () => {
        // Il pool di db.ts l'ha aperto l'import, in questo processo.
        await pool.end();
    });

    it('le richieste che arrivano insieme alla prima lettura aspettano la matrice, non prendono 403', async () => {
        const esiti = await runWithTenantContext(1, () => Promise.all(
            Array.from({ length: 8 }, () => RolePermissionService.hasPermission(1, UserRole.OWNER, 'floorplan:full')),
        ));
        expect(esiti).toEqual(Array(8).fill(true));
    });
});
