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

  const saltBytes = base64UrlDecode(saltBase64);

  const saltNormalBase64 = btoa(
    String.fromCharCode(...saltBytes)
  );

  const generated = await hashPassword(
    password,
    saltNormalBase64
  );

  const generatedHash = generated.split(':')[1];

  return constantTimeEqual(
    generatedHash,
    storedHash
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
// API DE DATOS PARA LA APLICACIÓN WEB
// ======================================================

const TABLE_COLUMNS = {
  perfilescr: ['id','nombre','apellido','documento','telefono','zona','email','password_hash','rol','meta_mensual','activo','created_at','updated_at'],
  llamadascr: ['id','asesor_id','cliente','llamada','tipo_gestion','zona','whatsapp_enviado','whatsapp_mensaje','whatsapp_respuesta','compromiso_pago','fecha_compromiso','pago','observaciones','fecha_llamada','created_at','updated_at'],
  encuestascr: ['id','llamada_id','asesor_id','codigo_usuario','calificacion_servicio','observacion_servicio','calificacion_tecnica','observacion_tecnica','calificacion_administrativa','observacion_administrativa','agilidad_averias','recomendaria','recomendacion_felicitacion','created_at','updated_at'],
  encuestas_seguimientocr: ['id','asesor_id','usuario','como_se_entero','fechas_pago','medio_contrato','atencion_asesor','redes_sociales','cobro_tecnico','medios_pago','created_at'],
  encuestas_serviciocr: ['id','asesor_id','usuario','servicio_retirado','motivo_retiro','interes_retomar','observaciones','created_at'],
  configuracioncr: ['id','color_principal','logo_url','updated_by','updated_at']
};

function tableAllowed(table) { return Object.prototype.hasOwnProperty.call(TABLE_COLUMNS, table); }
function columnAllowed(table, column) { return TABLE_COLUMNS[table]?.includes(column); }
function quoteIdent(name) { return `"${name.replaceAll('"','""')}"`; }

function buildWhere(table, filters, params, startIndex = 1) {
  const parts = [];
  let i = startIndex;
  for (const f of (filters || [])) {
    const [column, op, value] = f || [];
    if (op !== 'eq' || !columnAllowed(table, column)) continue;
    parts.push(`${quoteIdent(column)} = $${i++}`);
    params.push(value);
  }
  return parts.length ? ` WHERE ${parts.join(' AND ')}` : '';
}

async function enrichRows(sql, table, rows) {
  if (!rows?.length) return rows || [];
  if (table === 'llamadascr') {
    const ids = [...new Set(rows.map(r=>r.asesor_id).filter(Boolean))];
    if (!ids.length) return rows;
    const profiles = await sql`SELECT id,nombre,apellido,zona,email,activo FROM perfilescr WHERE id = ANY(${ids})`;
    const map = new Map(profiles.map(x=>[x.id,x]));
    return rows.map(r=>({...r, perfilescr: map.get(r.asesor_id) || null}));
  }
  if (table === 'encuestascr') {
    const advisorIds = [...new Set(rows.map(r=>r.asesor_id).filter(Boolean))];
    const callIds = [...new Set(rows.map(r=>r.llamada_id).filter(Boolean))];
    const profiles = advisorIds.length ? await sql`SELECT id,nombre,apellido,zona,email,rol,activo FROM perfilescr WHERE id = ANY(${advisorIds})` : [];
    const calls = callIds.length ? await sql`SELECT id,cliente,llamada,zona,fecha_llamada,asesor_id FROM llamadascr WHERE id = ANY(${callIds})` : [];
    const callAdvisorIds = [...new Set(calls.map(x=>x.asesor_id).filter(Boolean))];
    const callProfiles = callAdvisorIds.length ? await sql`SELECT id,nombre,apellido,email FROM perfilescr WHERE id = ANY(${callAdvisorIds})` : [];
    const pm = new Map(profiles.map(x=>[x.id,x]));
    const cpm = new Map(callProfiles.map(x=>[x.id,x]));
    const cm = new Map(calls.map(x=>[x.id,{...x,perfilescr:cpm.get(x.asesor_id)||null}]));
    return rows.map(r=>({...r,perfilescr:pm.get(r.asesor_id)||null,llamadascr: r.llamada_id ? (cm.get(r.llamada_id)||null) : null}));
  }
  return rows;
}

async function listData(sql, table, url, authUser) {
  const params=[];
  const filters=[];
  for (const raw of url.searchParams.getAll('eq')) {
    const idx=raw.indexOf(':');
    if(idx>0) filters.push([raw.slice(0,idx),'eq',raw.slice(idx+1)]);
  }
  // Never allow an asesor to read another asesor's private rows.
  if (authUser.rol !== 'administrador' && table !== 'configuracioncr' && table !== 'perfilescr') {
    filters.push(['asesor_id','eq',authUser.sub]);
  }
  const where=buildWhere(table,filters,params,1);
  const orders=[];
  for(const raw of url.searchParams.getAll('order')){
    const idx=raw.lastIndexOf(':');
    const col=idx>0?raw.slice(0,idx):raw;
    const dir=idx>0?raw.slice(idx+1):'asc';
    if(columnAllowed(table,col)) orders.push(`${quoteIdent(col)} ${dir==='desc'?'DESC':'ASC'}`);
  }
  const orderSql=orders.length?` ORDER BY ${orders.join(', ')}`:'';
  const limit=' LIMIT 5000';
  const rows=await sql.query(`SELECT ${TABLE_COLUMNS[table].map(quoteIdent).join(',')} FROM ${quoteIdent(table)}${where}${orderSql}${limit}`,params);
  const data=await enrichRows(sql,table,rows);
  return data;
}

async function insertData(sql, table, body, authUser) {
  const data={...(body.data||{})};
  if (table === 'perfilescr' && authUser.rol !== 'administrador') throw new Error('No autorizado');
  if (table === 'configuracioncr' && authUser.rol !== 'administrador') throw new Error('No autorizado');
  if (['llamadascr','encuestascr','encuestas_seguimientocr','encuestas_serviciocr'].includes(table) && authUser.rol !== 'administrador') data.asesor_id=authUser.sub;
  if (table === 'perfilescr') {
    data.id=data.id||crypto.randomUUID();
    data.rol=data.rol||'asesor';
    data.activo=data.activo ?? true;
    data.zona=data.zona ?? '';
    data.meta_mensual=Number(data.meta_mensual)||500;
    data.created_at=data.created_at||new Date().toISOString();
    data.updated_at=new Date().toISOString();
  }
  if (['llamadascr','encuestascr','encuestas_seguimientocr','encuestas_serviciocr'].includes(table)) {
    if (table !== 'llamadascr' && !data.asesor_id) data.asesor_id=authUser.sub;
    data.created_at=data.created_at||new Date().toISOString();
    if (table==='llamadascr'||table==='encuestascr') data.updated_at=new Date().toISOString();
  }
  if (table==='configuracioncr') data.updated_at=new Date().toISOString();
  const entries=Object.entries(data).filter(([k,v])=>columnAllowed(table,k) && v !== undefined);
  if(!entries.length) throw new Error('No hay datos para insertar');
  const cols=entries.map(([k])=>quoteIdent(k)).join(',');
  const placeholders=entries.map((_,i)=>`$${i+1}`).join(',');
  const values=entries.map(([,v])=>v);
  let query=`INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${placeholders})`;
  if(table==='configuracioncr') query += ` ON CONFLICT (id) DO UPDATE SET color_principal=EXCLUDED.color_principal, logo_url=EXCLUDED.logo_url, updated_by=EXCLUDED.updated_by, updated_at=NOW()`;
  query += ` RETURNING ${TABLE_COLUMNS[table].map(quoteIdent).join(',')}`;
  const rows=await sql.query(query,values);
  return (await enrichRows(sql,table,rows));
}

async function updateData(sql, table, body, authUser) {
  if (table === 'perfilescr' && authUser.rol !== 'administrador') throw new Error('No autorizado');
  if (table === 'configuracioncr' && authUser.rol !== 'administrador') throw new Error('No autorizado');
  const data={...(body.data||{})};
  delete data.id;
  data.updated_at=new Date().toISOString();
  const entries=Object.entries(data).filter(([k,v])=>columnAllowed(table,k) && v !== undefined);
  if(!entries.length) throw new Error('No hay campos para actualizar');
  const params=entries.map(([,v])=>v);
  const sets=entries.map(([k],i)=>`${quoteIdent(k)}=$${i+1}`).join(',');
  const filters=(body.filters||[]).slice();
  if(authUser.rol !== 'administrador' && table !== 'configuracioncr' && table !== 'perfilescr') filters.push(['asesor_id','eq',authUser.sub]);
  const where=buildWhere(table,filters,params,entries.length+1);
  const rows=await sql.query(`UPDATE ${quoteIdent(table)} SET ${sets}${where} RETURNING ${TABLE_COLUMNS[table].map(quoteIdent).join(',')}`,params);
  return await enrichRows(sql,table,rows);
}

async function deleteData(sql, table, body, authUser) {
  if (table !== 'llamadascr' || authUser.rol !== 'administrador') throw new Error('No autorizado');
  const params=[];
  const where=buildWhere(table,body.filters||[],params,1);
  if(!where) throw new Error('Filtro obligatorio');
  const rows=await sql.query(`DELETE FROM ${quoteIdent(table)}${where} RETURNING id`,params);
  return rows;
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
      // REGISTRO DE ASESOR
      // ==================================================

      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        const body = await request.json();
        const email = String(body.email || '').trim().toLowerCase();
        const password = String(body.password || '');
        if (!email || password.length < 6) return json({ok:false,error:'Correo y contraseña son obligatorios. La contraseña debe tener mínimo 6 caracteres.'},400);
        const existing = await sql`SELECT id FROM perfilescr WHERE LOWER(email)=${email} LIMIT 1`;
        if (existing.length) return json({ok:false,error:'Ese correo ya está registrado.'},409);
        const password_hash = await hashPassword(password);
        const id = crypto.randomUUID();
        const rows = await sql`
          INSERT INTO perfilescr (id,nombre,apellido,documento,telefono,zona,email,password_hash,rol,meta_mensual,activo,created_at,updated_at)
          VALUES (${id},${String(body.nombre||'').trim()},${String(body.apellido||'').trim()},${body.documento||null},${body.telefono||null},${body.zona||''},${email},${password_hash},'asesor',${Number(body.meta_mensual)||500},true,NOW(),NOW())
          RETURNING id,nombre,apellido,documento,telefono,zona,email,rol,meta_mensual,activo,created_at,updated_at
        `;
        const user=rows[0];
        const token=await createJWT({sub:user.id,nombre:user.nombre,apellido:user.apellido,email:user.email,rol:user.rol},env.JWT_SECRET);
        return json({ok:true,success:true,message:'Registro correcto',token,user});
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
      // DATOS DE LA APLICACIÓN
      // ==================================================

      if (url.pathname.startsWith('/api/data/')) {
        const table = decodeURIComponent(url.pathname.slice('/api/data/'.length));
        if (!tableAllowed(table)) return json({ok:false,error:'Tabla no permitida'},404);
        const auth = await requireAuth(request,env);
        if (auth.error) return auth.error;
        try {
          if (request.method === 'GET') {
            const data=await listData(sql,table,url,auth.user);
            return json({ok:true,data});
          }
          const body=await request.json().catch(()=>({}));
          if (request.method === 'POST') {
            const rows=await insertData(sql,table,body,auth.user);
            return json({ok:true,data:body.single?rows[0]||null:rows});
          }
          if (request.method === 'PATCH') {
            const rows=await updateData(sql,table,body,auth.user);
            return json({ok:true,data:body.single?rows[0]||null:rows});
          }
          if (request.method === 'DELETE') {
            const data=await deleteData(sql,table,body,auth.user);
            return json({ok:true,data});
          }
          return json({ok:false,error:'Método no permitido'},405);
        } catch (error) {
          console.error('DATA ERROR:',error);
          return json({ok:false,error:error.message||'No fue posible completar la operación'},400);
        }
      }

      // ==================================================
      // ADMINISTRACIÓN DE ASESORES
      // ==================================================

      if (url.pathname === '/api/admin/users' && request.method === 'POST') {
        const auth=await requireAdmin(request,env); if(auth.error) return auth.error;
        try {
          const body=await request.json();
          const action=body.action;
          if(action==='create') {
            const email=String(body.email||'').trim().toLowerCase();
            const password=String(body.password||'');
            if(!email||password.length<6) return json({ok:false,error:'Correo y contraseña son obligatorios.'},400);
            const exists=await sql`SELECT id FROM perfilescr WHERE LOWER(email)=${email} LIMIT 1`;
            if(exists.length) return json({ok:false,error:'Ese correo ya está registrado.'},409);
            const id=crypto.randomUUID(); const hash=await hashPassword(password);
            const rows=await sql`INSERT INTO perfilescr(id,nombre,apellido,documento,telefono,zona,email,password_hash,rol,meta_mensual,activo,created_at,updated_at) VALUES (${id},${body.nombre||''},${body.apellido||''},${body.documento||null},${body.telefono||null},${body.zona||''},${email},${hash},'asesor',${Number(body.meta_mensual)||500},true,NOW(),NOW()) RETURNING id,nombre,apellido,documento,telefono,zona,email,rol,meta_mensual,activo,created_at,updated_at`;
            return json({ok:true,data:rows[0]});
          }
          if(action==='update') {
            const uid=body.user_id;
            if(!uid) return json({ok:false,error:'Usuario requerido'},400);
            const fields={nombre:body.nombre||'',apellido:body.apellido||'',documento:body.documento||null,telefono:body.telefono||null,zona:body.zona||'',email:String(body.email||'').trim().toLowerCase(),meta_mensual:Number(body.meta_mensual)||500};
            const entries=Object.entries(fields); const params=entries.map(([,v])=>v); const sets=entries.map(([k],i)=>`${quoteIdent(k)}=$${i+1}`).join(',');
            params.push(uid); const rows=await sql.query(`UPDATE perfilescr SET ${sets},updated_at=NOW() WHERE id=$${params.length} RETURNING id,nombre,apellido,documento,telefono,zona,email,rol,meta_mensual,activo,created_at,updated_at`,params);
            if(!rows.length) return json({ok:false,error:'Usuario no encontrado'},404);
            return json({ok:true,data:rows[0]});
          }
          if(action==='delete') {
            const uid=body.user_id;
            const calls=await sql`SELECT COUNT(*)::int AS n FROM llamadascr WHERE asesor_id=${uid}`;
            if(Number(calls[0]?.n||0)>0) return json({ok:false,error:'No se puede eliminar el asesor porque tiene llamadas registradas.'},400);
            await sql`DELETE FROM encuestascr WHERE asesor_id=${uid}`;
            await sql`DELETE FROM encuestas_seguimientocr WHERE asesor_id=${uid}`;
            await sql`DELETE FROM encuestas_serviciocr WHERE asesor_id=${uid}`;
            const rows=await sql`DELETE FROM perfilescr WHERE id=${uid} RETURNING id`;
            if(!rows.length) return json({ok:false,error:'Usuario no encontrado'},404);
            return json({ok:true,data:rows[0]});
          }
          return json({ok:false,error:'Acción administrativa no válida'},400);
        } catch(error) { console.error('ADMIN ERROR:',error); return json({ok:false,error:error.message||'Error administrativo'},400); }
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
