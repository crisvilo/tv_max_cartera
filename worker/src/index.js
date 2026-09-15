// ============================================================
// GRUPO TV MAX - GESTIÓN DE CARTERA
// Cloudflare Worker + Neon PostgreSQL
// ============================================================

import { neon } from "@neondatabase/serverless";

// ============================================================
// CONFIGURACIÓN GENERAL
// ============================================================

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8"
};

// ============================================================
// RESPUESTAS
// ============================================================

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders
  });
}

function errorResponse(message, status = 500, detail = null) {
  return json(
    {
      ok: false,
      error: message,
      ...(detail ? { detail } : {})
    },
    status
  );
}

// ============================================================
// BASE DE DATOS
// ============================================================

function getDB(env) {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL no está configurada");
  }

  return neon(env.DATABASE_URL);
}

// ============================================================
// BASE64 / BASE64URL
// ============================================================

function base64UrlEncode(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  let base64 = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  while (base64.length % 4 !== 0) {
    base64 += "=";
  }

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

// ============================================================
// NORMALIZAR BASE64
// Permite comparar Base64 y Base64URL
// ============================================================

function normalizeBase64(value) {
  return String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/g, "");
}

// ============================================================
// COMPARACIÓN CONSTANTE
// ============================================================

function constantTimeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a));
  const bb = new TextEncoder().encode(String(b));

  if (aa.length !== bb.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < aa.length; i++) {
    result |= aa[i] ^ bb[i];
  }

  return result === 0;
}

// ============================================================
// HASH DE CONTRASEÑA
// PBKDF2 SHA-256
// ============================================================

async function hashPassword(password, saltBytes = null) {
  const encoder = new TextEncoder();

  const salt =
    saltBytes ||
    crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    key,
    256
  );

  const hashBytes = new Uint8Array(bits);

  return {
    salt: base64UrlEncode(salt),
    hash: base64UrlEncode(hashBytes)
  };
}

// ============================================================
// VERIFICAR CONTRASEÑA
// ============================================================

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;

  const parts = String(storedHash).trim().split(":");
  if (parts.length !== 2) return false;

  const saltText = parts[0].trim();
  const expectedHashText = parts[1].trim();
  if (!saltText || !expectedHashText) return false;

  try {
    const saltBytes = base64UrlDecode(saltText);
    const expectedHashBytes = base64UrlDecode(expectedHashText);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(String(password)),
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: saltBytes,
        iterations: 100000,
        hash: "SHA-256"
      },
      key,
      expectedHashBytes.length * 8
    );

    const generatedHashBytes = new Uint8Array(bits);

    if (generatedHashBytes.length !== expectedHashBytes.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < expectedHashBytes.length; i++) {
      result |= generatedHashBytes[i] ^ expectedHashBytes[i];
    }

    return result === 0;
  } catch (error) {
    console.error("Error verificando contraseña:", error);
    return false;
  }
}

// ============================================================
// JWT
// ============================================================

async function importJWTKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign", "verify"]
  );
}

async function createJWT(payload, secret) {
  if (!secret) {
    throw new Error("JWT_SECRET no está configurado");
  }

  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + 60 * 60 * 24
  };

  const encodedHeader = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header))
  );

  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(fullPayload))
  );

  const data = `${encodedHeader}.${encodedPayload}`;

  const key = await importJWTKey(secret);

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return `${data}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// ============================================================
// DECODIFICAR JWT
// ============================================================

function decodeJWT(token) {
  try {
    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    const payloadBytes = base64UrlDecode(parts[1]);

    return JSON.parse(
      new TextDecoder().decode(payloadBytes)
    );
  } catch {
    return null;
  }
}

// ============================================================
// VERIFICAR JWT
// ============================================================

async function verifyJWT(token, secret) {
  try {
    if (!token || !secret) {
      return null;
    }

    const parts = token.split(".");

    if (parts.length !== 3) {
      return null;
    }

    const data = `${parts[0]}.${parts[1]}`;

    const signature = base64UrlDecode(parts[2]);

    const key = await importJWTKey(secret);

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      signature,
      new TextEncoder().encode(data)
    );

    if (!valid) {
      return null;
    }

    const payload = decodeJWT(token);

    if (!payload) {
      return null;
    }

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch (error) {
    console.error("Error verificando JWT:", error);
    return null;
  }
}

// ============================================================
// OBTENER TOKEN
// ============================================================

function getToken(request) {
  const authorization = request.headers.get("Authorization");

  if (!authorization) {
    return null;
  }

  if (!authorization.startsWith("Bearer ")) {
    return null;
  }

  return authorization.substring(7).trim();
}

// ============================================================
// AUTENTICACIÓN
// ============================================================

async function requireAuth(request, env) {
  const token = getToken(request);

  if (!token) {
    return null;
  }

  return await verifyJWT(
    token,
    env.JWT_SECRET
  );
}

// ============================================================
// HEALTH
// ============================================================

async function handleHealth() {
  return json({
    ok: true,
    service: "Grupo TV MAX API",
    status: "online",
    databaseConfigured: true,
    environmentKeys: [
      "DATABASE_URL",
      "JWT_SECRET"
    ]
  });
}

// ============================================================
// DB TEST
// ============================================================

async function handleDBTest(env) {
  try {
    const sql = getDB(env);

    const result = await sql`
      SELECT
        NOW() AS fecha,
        current_database() AS base_datos
    `;

    return json({
      ok: true,
      database: "Neon conectado correctamente",
      result
    });
  } catch (error) {
    console.error("DB TEST ERROR:", error);

    return errorResponse(
      "Error conectando con Neon",
      500,
      error.message
    );
  }
}

// ============================================================
// DB SCHEMA
// ============================================================

async function handleDBSchema(env) {
  try {
    const sql = getDB(env);

    const result = await sql`
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
      result
    });
  } catch (error) {
    console.error("SCHEMA ERROR:", error);

    return errorResponse(
      "Error obteniendo esquema",
      500,
      error.message
    );
  }
}

// ============================================================
// LOGIN
// ============================================================

async function handleLogin(request, env) {
  try {
    const body = await request.json();

    const email = String(body.email || "")
      .trim()
      .toLowerCase();

    const password = String(body.password || "");

    if (!email || !password) {
      return errorResponse(
        "Correo y contraseña son obligatorios",
        400
      );
    }

    const sql = getDB(env);

    const users = await sql`
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
        activo,
        created_at,
        updated_at
      FROM perfilescr
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `;

    if (!users || users.length === 0) {
      return errorResponse(
        "Correo o contraseña incorrectos",
        401
      );
    }

    const user = users[0];

    if (!user.activo) {
      return errorResponse(
        "El usuario está inactivo",
        403
      );
    }

    const passwordValid = await verifyPassword(
      password,
      user.password_hash
    );

    if (!passwordValid) {
      return errorResponse(
        "Correo o contraseña incorrectos",
        401
      );
    }

    const token = await createJWT(
      {
        sub: user.id,
        email: user.email,
        nombre: user.nombre,
        apellido: user.apellido,
        rol: user.rol
      },
      env.JWT_SECRET
    );

    return json({
      ok: true,
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
      },
      session: {
        access_token: token,
        token_type: "bearer",
        expires_in: 86400
      },
      token
    });
  } catch (error) {
    console.error("LOGIN ERROR:", error);

    return errorResponse(
      "Error interno al iniciar sesión",
      500,
      error.message
    );
  }
}

// ============================================================
// ME
// ============================================================

async function handleMe(request, env) {
  try {
    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "Sesión no válida o expirada",
        401
      );
    }

    const sql = getDB(env);

    const users = await sql`
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
      WHERE id = ${auth.sub}
      LIMIT 1
    `;

    if (!users || users.length === 0) {
      return errorResponse(
        "Usuario no encontrado",
        404
      );
    }

    return json({
      ok: true,
      user: users[0]
    });
  } catch (error) {
    console.error("ME ERROR:", error);

    return errorResponse(
      "Error obteniendo usuario",
      500,
      error.message
    );
  }
}

// ============================================================
// AUTH TEST
// ============================================================

async function handleAuthTest(request, env) {
  const auth = await requireAuth(request, env);

  if (!auth) {
    return errorResponse(
      "No autenticado",
      401
    );
  }

  return json({
    ok: true,
    authenticated: true,
    user: auth
  });
}

// ============================================================
// REGISTRO DE USUARIO
// ============================================================

async function handleRegister(request, env) {
  try {
    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    if (
      auth.rol !== "administrador" &&
      auth.rol !== "admin"
    ) {
      return errorResponse(
        "No tienes permisos para crear usuarios",
        403
      );
    }

    const body = await request.json();

    const nombre = String(body.nombre || "").trim();
    const apellido = String(body.apellido || "").trim();
    const documento = body.documento || null;
    const telefono = body.telefono || null;
    const zona = String(body.zona || "").trim();
    const email = String(body.email || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");
    const rol = String(body.rol || "asesor").trim();
    const metaMensual = Number(body.meta_mensual || 0);

    if (
      !nombre ||
      !apellido ||
      !zona ||
      !email ||
      !password
    ) {
      return errorResponse(
        "Faltan campos obligatorios",
        400
      );
    }

    const sql = getDB(env);

    const existing = await sql`
      SELECT id
      FROM perfilescr
      WHERE LOWER(email) = ${email}
      LIMIT 1
    `;

    if (existing.length > 0) {
      return errorResponse(
        "Ya existe un usuario con ese correo",
        409
      );
    }

    const passwordData = await hashPassword(password);

    const passwordHash =
      `${passwordData.salt}:${passwordData.hash}`;

    const result = await sql`
      INSERT INTO perfilescr (
        nombre,
        apellido,
        documento,
        telefono,
        zona,
        email,
        password_hash,
        rol,
        meta_mensual,
        activo,
        created_at,
        updated_at
      )
      VALUES (
        ${nombre},
        ${apellido},
        ${documento},
        ${telefono},
        ${zona},
        ${email},
        ${passwordHash},
        ${rol},
        ${metaMensual},
        true,
        NOW(),
        NOW()
      )
      RETURNING
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
    `;

    return json({
      ok: true,
      user: result[0]
    }, 201);
  } catch (error) {
    console.error("REGISTER ERROR:", error);

    return errorResponse(
      "Error creando usuario",
      500,
      error.message
    );
  }
}

// ============================================================
// LISTAR USUARIOS
// ============================================================

async function handleUsers(request, env) {
  try {
    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    if (
      auth.rol !== "administrador" &&
      auth.rol !== "admin"
    ) {
      return errorResponse(
        "No tienes permisos",
        403
      );
    }

    const sql = getDB(env);

    const users = await sql`
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
      ORDER BY nombre, apellido
    `;

    return json({
      ok: true,
      data: users
    });
  } catch (error) {
    console.error("USERS ERROR:", error);

    return errorResponse(
      "Error obteniendo usuarios",
      500,
      error.message
    );
  }
}

// ============================================================
// TOGGLE USUARIO
// ============================================================

async function handleToggleUser(request, env, userId) {
  try {
    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    if (
      auth.rol !== "administrador" &&
      auth.rol !== "admin"
    ) {
      return errorResponse(
        "No tienes permisos",
        403
      );
    }

    const sql = getDB(env);

    const result = await sql`
      UPDATE perfilescr
      SET
        activo = NOT activo,
        updated_at = NOW()
      WHERE id = ${userId}
      RETURNING
        id,
        nombre,
        apellido,
        email,
        rol,
        activo
    `;

    if (result.length === 0) {
      return errorResponse(
        "Usuario no encontrado",
        404
      );
    }

    return json({
      ok: true,
      user: result[0]
    });
  } catch (error) {
    console.error("TOGGLE USER ERROR:", error);

    return errorResponse(
      "Error actualizando usuario",
      500,
      error.message
    );
  }
}

// ============================================================
// TABLAS PERMITIDAS
// ============================================================

const ALLOWED_TABLES = new Set([
  "perfilescr",
  "llamadascr",
  "encuestascr",
  "encuestas_seguimientocr",
  "encuestas_serviciocr",
  "configuracioncr"
]);

// ============================================================
// COLUMNAS PERMITIDAS
// ============================================================

const TABLE_COLUMNS = {
  perfilescr: [
    "id",
    "nombre",
    "apellido",
    "documento",
    "telefono",
    "zona",
    "email",
    "password_hash",
    "rol",
    "meta_mensual",
    "activo",
    "created_at",
    "updated_at"
  ],

  llamadascr: [
    "id",
    "asesor_id",
    "cliente",
    "llamada",
    "tipo_gestion",
    "zona",
    "whatsapp_enviado",
    "whatsapp_mensaje",
    "whatsapp_respuesta",
    "compromiso_pago",
    "fecha_compromiso",
    "pago",
    "observaciones",
    "fecha_llamada",
    "created_at",
    "updated_at"
  ],

  encuestascr: [
    "id",
    "llamada_id",
    "asesor_id",
    "codigo_usuario",
    "calificacion_servicio",
    "observacion_servicio",
    "calificacion_tecnica",
    "observacion_tecnica",
    "calificacion_administrativa",
    "observacion_administrativa",
    "agilidad_averias",
    "recomendaria",
    "recomendacion_felicitacion",
    "created_at",
    "updated_at"
  ],

  encuestas_seguimientocr: [
    "id",
    "asesor_id",
    "usuario",
    "como_se_entero",
    "fechas_pago",
    "medio_contrato",
    "atencion_asesor",
    "redes_sociales",
    "cobro_tecnico",
    "medios_pago",
    "created_at"
  ],

  encuestas_serviciocr: [
    "id",
    "asesor_id",
    "usuario",
    "servicio_retirado",
    "motivo_retiro",
    "interes_retomar",
    "observaciones",
    "created_at"
  ],

  configuracioncr: [
    "id",
    "color_principal",
    "logo_url",
    "updated_by",
    "updated_at"
  ]
};

// ============================================================
// OBTENER DATOS DE TABLA
// ============================================================

async function handleGetTable(request, env, table) {
  try {
    if (!ALLOWED_TABLES.has(table)) {
      return errorResponse(
        "Tabla no permitida",
        400
      );
    }

    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    const sql = getDB(env);

    const columns = TABLE_COLUMNS[table].join(", ");

    const query = `SELECT ${columns} FROM ${table} ORDER BY created_at DESC`;

    const result = await sql.query(query);

    return json({
      ok: true,
      data: result
    });
  } catch (error) {
    console.error("GET TABLE ERROR:", error);

    return errorResponse(
      "Error obteniendo datos",
      500,
      error.message
    );
  }
}

// ============================================================
// POST GENÉRICO
// ============================================================

async function handlePostTable(request, env, table) {
  try {
    if (!ALLOWED_TABLES.has(table)) {
      return errorResponse(
        "Tabla no permitida",
        400
      );
    }

    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    const body = await request.json();

    const allowedColumns = TABLE_COLUMNS[table];

    const entries = Object.entries(body)
      .filter(([key]) =>
        allowedColumns.includes(key) &&
        key !== "id" &&
        key !== "created_at" &&
        key !== "updated_at"
      );

    if (entries.length === 0) {
      return errorResponse(
        "No hay datos para insertar",
        400
      );
    }

    const columns = entries.map(([key]) => key);
    const values = entries.map(([, value]) => value);

    const placeholders = values
      .map((_, index) => `$${index + 1}`)
      .join(", ");

    const query = `
      INSERT INTO ${table}
      (${columns.join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `;

    const sql = getDB(env);

    const result = await sql.query(
      query,
      values
    );

    return json({
      ok: true,
      data: result
    }, 201);
  } catch (error) {
    console.error("POST TABLE ERROR:", error);

    return errorResponse(
      "Error insertando datos",
      500,
      error.message
    );
  }
}

// ============================================================
// PUT GENÉRICO
// ============================================================

async function handlePutTable(request, env, table, id) {
  try {
    if (!ALLOWED_TABLES.has(table)) {
      return errorResponse(
        "Tabla no permitida",
        400
      );
    }

    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    const body = await request.json();

    const allowedColumns = TABLE_COLUMNS[table];

    const entries = Object.entries(body)
      .filter(([key]) =>
        allowedColumns.includes(key) &&
        key !== "id" &&
        key !== "created_at" &&
        key !== "updated_at"
      );

    if (entries.length === 0) {
      return errorResponse(
        "No hay datos para actualizar",
        400
      );
    }

    const values = entries.map(([, value]) => value);

    const assignments = entries.map(
      ([key], index) =>
        `${key} = $${index + 1}`
    );

    values.push(id);

    const query = `
      UPDATE ${table}
      SET
        ${assignments.join(", ")},
        updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `;

    const sql = getDB(env);

    const result = await sql.query(
      query,
      values
    );

    if (!result || result.length === 0) {
      return errorResponse(
        "Registro no encontrado",
        404
      );
    }

    return json({
      ok: true,
      data: result
    });
  } catch (error) {
    console.error("PUT TABLE ERROR:", error);

    return errorResponse(
      "Error actualizando datos",
      500,
      error.message
    );
  }
}

// ============================================================
// DELETE GENÉRICO
// ============================================================

async function handleDeleteTable(request, env, table, id) {
  try {
    if (!ALLOWED_TABLES.has(table)) {
      return errorResponse(
        "Tabla no permitida",
        400
      );
    }

    const auth = await requireAuth(request, env);

    if (!auth) {
      return errorResponse(
        "No autenticado",
        401
      );
    }

    if (
      auth.rol !== "administrador" &&
      auth.rol !== "admin"
    ) {
      return errorResponse(
        "No tienes permisos para eliminar",
        403
      );
    }

    const sql = getDB(env);

    const query = `
      DELETE FROM ${table}
      WHERE id = $1
      RETURNING *
    `;

    const result = await sql.query(
      query,
      [id]
    );

    if (!result || result.length === 0) {
      return errorResponse(
        "Registro no encontrado",
        404
      );
    }

    return json({
      ok: true,
      data: result
    });
  } catch (error) {
    console.error("DELETE TABLE ERROR:", error);

    return errorResponse(
      "Error eliminando datos",
      500,
      error.message
    );
  }
}


// ============================================================
// DIAGNÓSTICO TEMPORAL DE PBKDF2
// ============================================================

async function handleLoginDiagnostic(request, env) {
  try {
    const body = await request.json();
    const email = String(body?.email || "").trim().toLowerCase();
    const password = String(body?.password ?? "");

    if (!email) {
      return json({ ok: false, error: "Falta email" }, 400);
    }

    const sql = getDB(env);

    const rows = await sql`
      SELECT
        id,
        email,
        activo,
        password_hash
      FROM perfilescr
      WHERE lower(email) = ${email}
      LIMIT 1
    `;

    if (!rows.length) {
      return json({
        ok: true,
        diagnostic: {
          userFound: false,
          active: false,
          hashPresent: false
        }
      });
    }

    const user = rows[0];
    const stored = String(user.password_hash || "");
    const parts = stored.trim().split(":");
    const hashFormat = parts.length === 2 && !!parts[0] && !!parts[1];

    if (!hashFormat) {
      return json({
        ok: true,
        diagnostic: {
          userFound: true,
          active: Boolean(user.activo),
          hashPresent: Boolean(stored),
          hashFormat: false
        }
      });
    }

    const saltText = parts[0].trim();
    const expectedHashText = parts[1].trim();

    let saltBytes;
    let expectedHashBytes;
    let generatedHashBytes;
    let derivedHashText = "";
    let byteComparison = false;

    try {
      saltBytes = base64UrlDecode(saltText);
      expectedHashBytes = base64UrlDecode(expectedHashText);

      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveBits"]
      );

      const bits = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: saltBytes,
          iterations: 100000,
          hash: "SHA-256"
        },
        key,
        expectedHashBytes.length * 8
      );

      generatedHashBytes = new Uint8Array(bits);
      derivedHashText = base64UrlEncode(generatedHashBytes);

      if (generatedHashBytes.length === expectedHashBytes.length) {
        let result = 0;
        for (let i = 0; i < expectedHashBytes.length; i++) {
          result |= generatedHashBytes[i] ^ expectedHashBytes[i];
        }
        byteComparison = result === 0;
      }
    } catch (error) {
      return json({
        ok: true,
        diagnostic: {
          userFound: true,
          active: Boolean(user.activo),
          hashPresent: true,
          hashFormat: true,
          cryptoError: String(error?.message || error)
        }
      });
    }

    return json({
      ok: true,
      diagnostic: {
        userFound: true,
        active: Boolean(user.activo),
        hashPresent: true,
        hashFormat: true,
        saltLengthChars: saltText.length,
        saltBytes: saltBytes.length,
        hashLengthChars: expectedHashText.length,
        hashBytes: expectedHashBytes.length,
        generatedHashLength: generatedHashBytes.length,
        passwordValid: byteComparison,
        storedHashPrefix: expectedHashText.slice(0, 12),
        generatedHashPrefix: derivedHashText.slice(0, 12)
      }
    });
  } catch (error) {
    return errorResponse(
      "Error en diagnóstico de login",
      500,
      String(error?.message || error)
    );
  }
}

// ============================================================
// ROUTER
// ============================================================

async function router(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;
  const method = request.method.toUpperCase();

  // ----------------------------------------------------------
  // OPTIONS / CORS
  // ----------------------------------------------------------

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  // ----------------------------------------------------------
  // HEALTH
  // ----------------------------------------------------------

  if (
    pathname === "/api/health" &&
    method === "GET"
  ) {
    return await handleHealth();
  }

  // ----------------------------------------------------------
  // DB TEST
  // ----------------------------------------------------------

  if (
    pathname === "/api/db-test" &&
    method === "GET"
  ) {
    return await handleDBTest(env);
  }

  // ----------------------------------------------------------
  // DB SCHEMA
  // ----------------------------------------------------------

  if (
    pathname === "/api/db-schema" &&
    method === "GET"
  ) {
    return await handleDBSchema(env);
  }

  // ----------------------------------------------------------
  // LOGIN DIAGNOSTIC (TEMPORAL)
  // ----------------------------------------------------------

  if (
    pathname === "/api/auth/login-diagnostic" &&
    method === "POST"
  ) {
    return await handleLoginDiagnostic(request, env);
  }

  // ----------------------------------------------------------
  // LOGIN
  // ----------------------------------------------------------

  if (
    pathname === "/api/auth/login" &&
    method === "POST"
  ) {
    return await handleLogin(request, env);
  }

  // ----------------------------------------------------------
  // ME
  // ----------------------------------------------------------

  if (
    pathname === "/api/auth/me" &&
    method === "GET"
  ) {
    return await handleMe(request, env);
  }

  // ----------------------------------------------------------
  // AUTH TEST
  // ----------------------------------------------------------

  if (
    pathname === "/api/auth/test" &&
    method === "GET"
  ) {
    return await handleAuthTest(request, env);
  }

  // ----------------------------------------------------------
  // REGISTER
  // ----------------------------------------------------------

  if (
    pathname === "/api/auth/register" &&
    method === "POST"
  ) {
    return await handleRegister(request, env);
  }

  // ----------------------------------------------------------
  // ADMIN USERS
  // ----------------------------------------------------------

  if (
    pathname === "/api/admin/users" &&
    method === "GET"
  ) {
    return await handleUsers(request, env);
  }

  // ----------------------------------------------------------
  // TOGGLE USER
  // ----------------------------------------------------------

  const toggleMatch = pathname.match(
    /^\/api\/admin\/users\/([^/]+)\/toggle$/
  );

  if (
    toggleMatch &&
    method === "PATCH"
  ) {
    return await handleToggleUser(
      request,
      env,
      toggleMatch[1]
    );
  }

  // ----------------------------------------------------------
  // TABLE ROUTES
  // ----------------------------------------------------------

  const tableMatch = pathname.match(
    /^\/api\/data\/([^/]+)$/
  );

  if (tableMatch) {
    const table = tableMatch[1];

    if (method === "GET") {
      return await handleGetTable(
        request,
        env,
        table
      );
    }

    if (method === "POST") {
      return await handlePostTable(
        request,
        env,
        table
      );
    }
  }

  // ----------------------------------------------------------
  // TABLE ID ROUTES
  // ----------------------------------------------------------

  const tableIdMatch = pathname.match(
    /^\/api\/data\/([^/]+)\/([^/]+)$/
  );

  if (tableIdMatch) {
    const table = tableIdMatch[1];
    const id = tableIdMatch[2];

    if (method === "PUT" || method === "PATCH") {
      return await handlePutTable(
        request,
        env,
        table,
        id
      );
    }

    if (method === "DELETE") {
      return await handleDeleteTable(
        request,
        env,
        table,
        id
      );
    }
  }

  // ----------------------------------------------------------
  // 404
  // ----------------------------------------------------------

  return errorResponse(
    "Ruta no encontrada",
    404
  );
}

// ============================================================
// ENTRY POINT
// ============================================================

export default {
  async fetch(request, env, ctx) {
    try {
      return await router(
        request,
        env,
        ctx
      );
    } catch (error) {
      console.error(
        "WORKER ERROR:",
        error
      );

      return errorResponse(
        "Error interno del servidor",
        500,
        error.message
      );
    }
  }
};
