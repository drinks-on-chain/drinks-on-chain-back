import { effectiveStatus } from '@modules/invitations/invitations.service';
import { MailRenderer } from '@modules/mail/mail.renderer';
import { ACCOUNT_TEMPLATES } from '@modules/mail/templates/account';
import { levelOf, permissionMatrix, platformRolesWith } from '../permissions';

describe('Matriz de permisos (PLT-04, contrato O1 §9)', () => {
  it('cada capacidad trae los 11 roles', () => {
    const matrix = permissionMatrix();
    expect(matrix.capabilities.map((c) => c.key)).toEqual([
      'platform.users',
      'settings',
      'applications',
      'waitlist',
      'wineries.suspend',
      'wineries.revoke',
      'team',
      'audit',
    ]);
    for (const c of matrix.capabilities) {
      expect(Object.keys(c.roles)).toHaveLength(11);
    }
  });

  it('las rutas salen de la misma matriz', () => {
    expect(platformRolesWith('platform.users', 'FULL')).toEqual([
      'SUPERADMIN',
      'ADMIN',
    ]);
    expect(platformRolesWith('team', 'FULL')).toEqual([
      'SUPERADMIN',
      'ADMIN',
      'OPERATIONS',
      'SUPPORT',
    ]);
    expect(platformRolesWith('waitlist', 'FULL', 'READ')).toEqual([
      'SUPERADMIN',
      'ADMIN',
      'OPERATIONS',
      'SUPPORT',
    ]);
    expect(platformRolesWith('waitlist', 'FULL')).toEqual([
      'SUPERADMIN',
      'ADMIN',
      'OPERATIONS',
    ]);
    expect(levelOf('settings', 'SUPPORT')).toBe('READ');
    expect(levelOf('audit', 'OWNER')).toBe('OWN');
    expect(levelOf('platform.users', 'OWNER')).toBe('NONE');
  });
});

describe('Invitaciones: estado presentado', () => {
  it('una pendiente vencida es EXPIRED', () => {
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 60_000);
    expect(effectiveStatus({ status: 'PENDING', expiresAt: past })).toBe(
      'EXPIRED',
    );
    expect(effectiveStatus({ status: 'PENDING', expiresAt: future })).toBe(
      'PENDING',
    );
    expect(effectiveStatus({ status: 'ACCEPTED', expiresAt: past })).toBe(
      'ACCEPTED',
    );
  });
});

describe('Plantillas de correo de la Ola 1 (CMP-02)', () => {
  const renderer = new MailRenderer();
  const sample: Record<string, string | number> = {
    nombre: 'Ana',
    invitante: 'Jorge <b>',
    organizacion: 'Altos',
    rol: 'enología',
    enlace: 'http://localhost:3002/invitacion/abc',
    caduca: '30 de septiembre de 2026',
    minutos: 60,
    horas: 48,
    intentos: 5,
    cambio: 'Se invitó a x@y.bo',
    motivo: '',
  };

  it.each(ACCOUNT_TEMPLATES.map((t) => t.name))(
    '%s se renderiza en texto y HTML escapado',
    (name) => {
      const mail = renderer.render(name, sample);
      expect(mail.subject.length).toBeGreaterThan(5);
      expect(mail.text).toContain('Drinks on Chain');
      expect(mail.html).not.toContain('<b>');
    },
  );

  it('aviso al dueño con y sin motivo', () => {
    expect(
      renderer.render('aviso-equipo', { ...sample, motivo: 'Soporte' }).text,
    ).toContain('Motivo: Soporte');
    expect(renderer.render('aviso-equipo', sample).text).not.toContain(
      'Motivo',
    );
  });
});
