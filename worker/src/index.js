import { neon } from '@neondatabase/serverless';

// ======================================================
// CORS
// ======================================================

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
};

// ======================================================
// RESPUESTAS JSON
// ======================================================

const json = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors,
      'Content-Type': 'application/json'
    }
  });
};

// ======================================================
// BASE64URL
// ======================================================

function base64UrlEncode(data) {
  let bytes;

  if (typeof data === 'string') {
    bytes = new TextEncoder().encode(data);
  } else {
    bytes = new Uint8Array(data);
  }

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  value = value
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  while (value.length % 4) {
    value += '=';
  }

  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// ======================================================
// COMPARACIÓN SEGURA
// ======================================================

function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

// ======================================================
// HASH DE CONTRASEÑA
// PBKDF2 SHA-256
// ======================================================

async function hashPassword(password, saltBase64 = null) {

  const enc = new TextEncoder();

  let salt;

  if (saltBase64) {

    salt = Uint8Array.from(
      atob(saltBase64),
      c => c.charCodeAt(0)
    );

  } else {

    salt = crypto.getRandomValues(
      new Uint8Array(16)
    );

  }

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
      salt: salt,
      iterations: 210000,
      hash: 'SHA-256'
    },
    key,
    256
  );

  const hashArray = new Uint8Array(bits);

  return `${base64UrlEncode(salt)}:${base64UrlEncode(hashArray)}`;
}

// ======================================================
// VERIFICAR CONTRASEÑA
// ======================================================

async function verifyPassword(password, storedPassword) {

  if (!storedPassword) {
    return false;
  }

  const parts = storedPassword.split(':');

  if (parts.length !== 2) {
    return false;
  }

  const saltBase64 = parts[0];
  const storedHash = parts[1];

  if (!saltBase64 || !storedHash) {
    return false;
  }

  // El hash guardado en Neon fue generado en Base64 estándar
  // (termina en =), mientras que algunas versiones anteriores
  // del Worker usaban Base64URL. Normalizamos ambos formatos.
  const normalizeBase64 = (value) =>
    String(value || '')
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/=+$/g, '');

  const saltBytes = base64UrlDecode(saltBase64);
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 210000,
      hash: 'SHA-256'
    },
    key,
    256
  );

  const generatedHashBytes = new Uint8Array(bits);
  const generatedHashStandard = btoa(
    String.fromCharCode(...generatedHashBytes)
  );

  return constantTimeEqual(
    normalizeBase64(generatedHashStandard),
    normalizeBase64(storedHash)
  );
}

// ======================================================
// JWT
// ======================================================

async function createJWT(payload, secret) {

  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };

  const now = Math.floor(Date.now() / 1000);

  const completePayload = {
    ...payload,
    iat: now,
    exp: now + (60 * 60 * 8)
  };

  const encodedHeader = base64UrlEncode(
    JSON.stringify(header)
  );

  const encodedPayload = base64UrlEncode(
    JSON.stringify(completePayload)
  );

  const data =
    `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    {
      name: 'HMAC',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(data)
  );

  const encodedSignature =
    base64UrlEncode(signature);

  return `${data}.${encodedSignature}`;
}

// ======================================================
// VERIFICAR JWT
// ======================================================

async function verifyJWT(token, secret) {

  try {

    const parts = token.split('.');

    if (parts.length !== 3) {
      return null;
    }

    const [
      encodedHeader,
      encodedPayload,
      encodedSignature
    ] = parts;

    const data =
      `${encodedHeader}.${encodedPayload}`;

    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      {
        name: 'HMAC',
        hash: 'SHA-256'
      },
      false,
      ['verify']
    );

    const signature =
      base64UrlDecode(encodedSignature);

    const valid =
      await crypto.subtle.verify(
        'HMAC',
        key,
        signature,
        new TextEncoder().encode(data)
      );

    if (!valid) {
      return null;
    }

    const payloadBytes =
      base64UrlDecode(encodedPayload);

    const payloadText =
      new TextDecoder().decode(payloadBytes);

    const payload =
      JSON.parse(payloadText);

    const now =
      Math.floor(Date.now() / 1000);

    if (!payload.exp || payload.exp <= now) {
      return null;
    }

    return payload;

  } catch (error) {

    console.error(
      'Error verificando JWT:',
      error
    );

    return null;
  }
}

// ======================================================
// OBTENER TOKEN DEL REQUEST
// ======================================================

function getBearerToken(request) {

  const authorization =
    request.headers.get('Authorization');

  if (!authorization) {
    return null;
  }

  if (!authorization.startsWith('Bearer ')) {
    return null;
  }

  return authorization.substring(7).trim();
}

// ======================================================
// AUTENTICAR USUARIO
// ======================================================

async function requireAuth(request, env) {

  const token =
    getBearerToken(request);

  if (!token) {
    return {
      error: json(
        {
          ok: false,
          error: 'Token de autenticación requerido'
        },
        401
      )
    };
  }

  if (!env.JWT_SECRET) {
    return {
      error: json(
        {
          ok: false,
          error: 'JWT_SECRET no está configurado'
        },
        500
      )
    };
  }

  const payload =
    await verifyJWT(
      token,
      env.JWT_SECRET
    );

  if (!payload) {
    return {
      error: json(
        {
          ok: false,
          error: 'Token inválido o expirado'
        },
        401
      )
    };
  }

  return {
    user: payload
  };
}

// ======================================================
// VERIFICAR ADMINISTRADOR
// ======================================================

async function requireAdmin(request, env) {

  const auth =
    await requireAuth(request, env);

  if (auth.error) {
    return auth;
  }

  if (auth.user.rol !== 'administrador') {
    return {
      error: json(
        {
          ok: false,
          error: 'Acceso exclusivo para administradores'
        },
        403
      )
    };
  }

  return auth;
}

// ======================================================
// WORKER
// ======================================================

export default {

  async fetch(request, env) {

    // --------------------------------------------------
    // OPTIONS / CORS
    // --------------------------------------------------

    if (request.method === 'OPTIONS') {

      return new Response(null, {
        status: 204,
        headers: cors
      });

    }

    try {

      const url =
        new URL(request.url);

      // ==================================================
      // HEALTH
      // ==================================================

      if (
        url.pathname === '/api/health' &&
        request.method === 'GET'
      ) {

        return json({
          ok: true,
          service: 'Grupo TV MAX API',
          status: 'online',
          databaseConfigured:
            Boolean(env.DATABASE_URL),
          jwtConfigured:
            Boolean(env.JWT_SECRET)
        });

      }

      // ==================================================
      // VERIFICAR DATABASE
      // ==================================================

      if (!env.DATABASE_URL) {

        return json(
          {
            ok: false,
            error: 'DATABASE_URL no está configurada'
          },
          500
        );

      }

      const sql =
        neon(env.DATABASE_URL);

      // ==================================================
      // DB TEST
      // ==================================================

      if (
        url.pathname === '/api/db-test' &&
        request.method === 'GET'
      ) {

        const result = await sql`
          SELECT
            NOW() AS fecha,
            current_database() AS base_datos
        `;

        return json({
          ok: true,
          database:
            'Neon conectado correctamente',
          result
        });

      }

      // ==================================================
      // DB SCHEMA
      // ==================================================

      if (
        url.pathname === '/api/db-schema' &&
        request.method === 'GET'
      ) {

        const tablas = await sql`
          SELECT
            table_name
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'
          ORDER BY table_name
        `;

        const columnas = await sql`
          SELECT
            table_name,
            column_name,
            data_type,
            is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position
        `;

        return json({
          ok: true,
          tablas,
          columnas
        });

      }

      // ==================================================
      // LOGIN
      // ==================================================

      if (
        url.pathname === '/api/auth/login' &&
        request.method === 'POST'
      ) {

        const body =
          await request.json();

        const email =
          String(body.email || '')
            .trim()
            .toLowerCase();

        const password =
          String(body.password || '');

        if (!email || !password) {

          return json(
            {
              ok: false,
              error:
                'Email y contraseña son obligatorios'
            },
            400
          );

        }

        if (!env.JWT_SECRET) {

          return json(
            {
              ok: false,
              error:
                'JWT_SECRET no está configurado'
            },
            500
          );

        }

        // ------------------------------------------------
        // BUSCAR USUARIO
        // ------------------------------------------------

        const rows = await sql`
          SELECT
            id,
            nombre,
            apellido,
            documento,
            telefono,
            zona,
            email,
            password_hash,
            rol,
            meta_mensual,
            activo
          FROM perfilescr
          WHERE LOWER(email) = ${email}
          LIMIT 1
        `;

        const user =
          rows[0];

        if (!user) {

          return json(
            {
              ok: false,
              error: 'Credenciales inválidas'
            },
            401
          );

        }

        // ------------------------------------------------
        // USUARIO ACTIVO
        // ------------------------------------------------

        if (!user.activo) {

          return json(
            {
              ok: false,
              error: 'Usuario inactivo'
            },
            403
          );

        }

        // ------------------------------------------------
        // VERIFICAR PASSWORD
        // ------------------------------------------------

        const passwordCorrect =
          await verifyPassword(
            password,
            user.password_hash
          );

        if (!passwordCorrect) {

          return json(
            {
              ok: false,
              error: 'Credenciales inválidas'
            },
            401
          );

        }

        // ------------------------------------------------
        // CREAR JWT
        // ------------------------------------------------

        const token =
          await createJWT(
            {
              sub: user.id,
              nombre: user.nombre,
              apellido: user.apellido,
              email: user.email,
              rol: user.rol
            },
            env.JWT_SECRET
          );

        // ------------------------------------------------
        // RESPUESTA
        // ------------------------------------------------

        return json({
          ok: true,
          success: true,
          message: 'Login correcto',

          token,

          user: {
            id: user.id,
            nombre: user.nombre,
            apellido: user.apellido,
            documento: user.documento,
            telefono: user.telefono,
            zona: user.zona,
            email: user.email,
            rol: user.rol,
            meta_mensual: user.meta_mensual,
            activo: user.activo
          }
        });

      }

      // ==================================================
      // MI SESIÓN
      // ==================================================

      if (
        url.pathname === '/api/auth/me' &&
        request.method === 'GET'
      ) {

        const auth =
          await requireAuth(
            request,
            env
          );

        if (auth.error) {
          return auth.error;
        }

        const rows = await sql`
          SELECT
            id,
            nombre,
            apellido,
            documento,
            telefono,
            zona,
            email,
            rol,
            meta_mensual,
            activo,
            created_at,
            updated_at
          FROM perfilescr
          WHERE id = ${auth.user.sub}
          LIMIT 1
        `;

        const user =
          rows[0];

        if (!user) {

          return json(
            {
              ok: false,
              error:
                'El usuario ya no existe'
            },
            401
          );

        }

        if (!user.activo) {

          return json(
            {
              ok: false,
              error: 'Usuario inactivo'
            },
            403
          );

        }

        return json({
          ok: true,
          user
        });

      }

      // ==================================================
      // PRUEBA DE RUTA PROTEGIDA
      // ==================================================

      if (
        url.pathname === '/api/auth/test' &&
        request.method === 'GET'
      ) {

        const auth =
          await requireAuth(
            request,
            env
          );

        if (auth.error) {
          return auth.error;
        }

        return json({
          ok: true,
          message:
            'Autenticación JWT funcionando correctamente',
          user: auth.user
        });

      }

      // ==================================================
      // RUTA NO ENCONTRADA
      // ==================================================

      return json(
        {
          ok: false,
          error: 'Ruta no encontrada'
        },
        404
      );

    } catch (error) {

      console.error(
        'ERROR WORKER:',
        error
      );

      return json(
        {
          ok: false,
          error:
            'Error interno del servidor',
          detail:
            error.message
        },
        500
      );

    }

  }

};

// ======================================================
// EXPORTACIONES
// ======================================================

export {
  hashPassword,
  verifyPassword,
  createJWT,
  verifyJWT
};
