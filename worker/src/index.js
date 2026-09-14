import { neon } from '@neondatabase/serverless';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
};

const json = (data, status = 200) => {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...cors,
        'Content-Type': 'application/json'
      }
    }
  );
};

async function hashPassword(password, saltBase64) {

  const enc = new TextEncoder();

  const salt = saltBase64
    ? Uint8Array.from(
        atob(saltBase64),
        c => c.charCodeAt(0)
      )
    : crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 210000,
      hash: 'SHA-256'
    },
    key,
    256
  );

  const hashArray = new Uint8Array(bits);

  return `${btoa(String.fromCharCode(...salt))}:${btoa(
    String.fromCharCode(...hashArray)
  )}`;
}

async function verifyPassword(password, stored) {

  if (!stored) {
    return false;
  }

  const [salt, hash] = stored.split(':');

  if (!salt || !hash) {
    return false;
  }

  const generated = await hashPassword(password, salt);

  return generated.split(':')[1] === hash;
}

export default {

  async fetch(request, env) {

    if (request.method === 'OPTIONS') {

      return new Response(
        null,
        {
          headers: cors
        }
      );

    }

    try {

      const url = new URL(request.url);

      /*
       =========================
       HEALTH CHECK
       =========================
      */

      if (url.pathname === '/api/health') {

        return json({
          ok: true,
          service: 'Grupo TV MAX API',
          status: 'online',
          databaseConfigured: Boolean(env.DATABASE_URL),
          environmentKeys: Object.keys(env)
        });

      }


      /*
       =========================
       VERIFICAR DATABASE
       =========================
      */

      if (!env.DATABASE_URL) {

        return json(
          {
            error: 'DATABASE_URL no está configurada'
          },
          500
        );

      }


      /*
       =========================
       CONEXIÓN NEON
       =========================
      */

      const sql = neon(env.DATABASE_URL);


      /*
       =========================
       LOGIN
       =========================
      */

      if (
        url.pathname === '/api/auth/login' &&
        request.method === 'POST'
      ) {

        const body = await request.json();

        const email = body.email;
        const password = body.password;

        if (!email || !password) {

          return json(
            {
              error: 'Email y contraseña son obligatorios'
            },
            400
          );

        }


        const rows = await sql`

          SELECT
            id,
            nombre,
            apellido,
            email,
            rol,
            activo,
            password_hash

          FROM perfilescr

          WHERE LOWER(email) = LOWER(${email})

          LIMIT 1

        `;


        const user = rows[0];


        if (!user) {

          return json(
            {
              error: 'Credenciales inválidas'
            },
            401
          );

        }


        if (!user.activo) {

          return json(
            {
              error: 'Usuario inactivo'
            },
            403
          );

        }


        const passwordCorrect = await verifyPassword(
          password,
          user.password_hash
        );


        if (!passwordCorrect) {

          return json(
            {
              error: 'Credenciales inválidas'
            },
            401
          );

        }


        return json({

          success: true,

          message: 'Login correcto',

          user: {

            id: user.id,
            nombre: user.nombre,
            apellido: user.apellido,
            email: user.email,
            rol: user.rol

          }

        });

      }


      /*
       =========================
       RUTA NO ENCONTRADA
       =========================
      */

      return json(
        {
          error: 'Ruta no encontrada'
        },
        404
      );

    }
    catch (error) {

      console.error(
        'ERROR WORKER:',
        error
      );

      return json(
        {
          error: 'Error interno del servidor',
          detail: error.message
        },
        500
      );

    }

  }

};

export {
  hashPassword
};
