import { neon } from '@neondatabase/serverless';

const cors = {'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}});

async function hashPassword(password, saltBase64){
  const enc=new TextEncoder();
  const salt=saltBase64?Uint8Array.from(atob(saltBase64),c=>c.charCodeAt(0)):crypto.getRandomValues(new Uint8Array(16));
  const key=await crypto.subtle.importKey('raw',enc.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:210000,hash:'SHA-256'},key,256);
  return `${btoa(String.fromCharCode(...salt))}:${btoa(String.fromCharCode(...new Uint8Array(bits)))}`;
}
async function verifyPassword(password, stored){ const [salt,hash]=stored.split(':'); return (await hashPassword(password,salt)).split(':')[1]===hash; }

export default { async fetch(request, env) {
  if(request.method==='OPTIONS') return new Response(null,{headers:cors});
  const url=new URL(request.url); const sql=neon(env.DATABASE_URL);
  try {
    if(url.pathname==='/api/health') return json({ok:true,service:'Grupo TV MAX API'});
    if(url.pathname==='/api/auth/login' && request.method==='POST') {
      const {email,password}=await request.json();
      if(!email||!password) return json({error:'Email y contraseña son obligatorios'},400);
      const rows=await sql`select id,nombre,apellido,email,rol,activo,password_hash from perfilescr where lower(email)=lower(${email}) limit 1`;
      const user=rows[0];
      if(!user || !user.activo || !(await verifyPassword(password,user.password_hash))) return json({error:'Credenciales inválidas'},401);
      return json({user:{id:user.id,nombre:user.nombre,apellido:user.apellido,email:user.email,rol:user.rol},message:'Login correcto'});
    }
    return json({error:'Ruta no encontrada'},404);
  } catch(e) { return json({error:'Error interno',detail:e.message},500); }
}};
export {hashPassword};
