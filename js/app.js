/* =========================================================
   SISTEMA DE CARTERA - API CLOUDFLARE WORKER + NEON
   ========================================================= */
(function () {
  "use strict";
  if (window.__carteraAppLoaded) return;
  window.__carteraAppLoaded = true;

  const API_BASE = "https://tvmaxcartera.cdviloria25.workers.dev";
  const TOKEN_KEY = "tvmax_cartera_token";

  function getToken(){ return localStorage.getItem(TOKEN_KEY) || ""; }
  function setToken(token){ if(token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); }

  async function apiFetch(path, options={}) {
    const headers = new Headers(options.headers || {});
    headers.set("Content-Type", "application/json");
    const token = getToken();
    if(token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${API_BASE}${path}`, {...options, headers});
    const body = await response.json().catch(()=>({}));
    if(!response.ok) return { ok:false, status:response.status, body };
    return { ok:true, status:response.status, body };
  }

  function createQuery(table){
    const state = {table, filters:[], orders:[], action:"select", payload:null, selectText:"*", upsert:false};
    const builder = {
      select(text="*") { state.selectText=text; return builder; },
      eq(column,value) { state.filters.push([column,"eq",value]); return builder; },
      order(column,opts={}) { state.orders.push([column, opts.ascending !== false]); return builder; },
      insert(payload) { state.action="insert"; state.payload=payload; return builder; },
      update(payload) { state.action="update"; state.payload=payload; return builder; },
      delete() { state.action="delete"; return builder; },
      upsert(payload,opts={}) { state.action="upsert"; state.payload=payload; state.upsert=true; return builder; },
      single(){ state.single=true; return executeQuery(state); },
      maybeSingle(){ state.maybeSingle=true; return executeQuery(state); },
      then(resolve,reject){ return executeQuery(state).then(resolve,reject); },
      catch(reject){ return executeQuery(state).catch(reject); }
    };
    return builder;
  }

  async function executeQuery(state){
    const params = new URLSearchParams();
    if(state.selectText) params.set("select", state.selectText);
    state.filters.forEach(([c,o,v])=>params.append("eq", `${c}:${String(v)}`));
    state.orders.forEach(([c,a])=>params.append("order", `${c}:${a?"asc":"desc"}`));
    if(state.single) params.set("single","true");
    if(state.maybeSingle) params.set("maybeSingle","true");

    let result;
    if(state.action === "select") {
      result = await apiFetch(`/api/data/${encodeURIComponent(state.table)}?${params.toString()}`);
    } else if(state.action === "insert") {
      result = await apiFetch(`/api/data/${encodeURIComponent(state.table)}`, {method:"POST", body:JSON.stringify(state.payload)});
    } else if(state.action === "update") {
      const idFilter = state.filters.find(([column, operator]) => column === "id" && operator === "eq");
      if (idFilter) {
        result = await apiFetch(`/api/data/${encodeURIComponent(state.table)}/${encodeURIComponent(String(idFilter[2]))}`, {method:"PATCH", body:JSON.stringify(state.payload)});
      } else {
        result = {ok:false,status:400,body:{error:"La actualización requiere el id del registro"}};
      }
    } else if(state.action === "delete") {
      const idFilter = state.filters.find(([column, operator]) => column === "id" && operator === "eq");
      if (idFilter) {
        result = await apiFetch(`/api/data/${encodeURIComponent(state.table)}/${encodeURIComponent(String(idFilter[2]))}`, {method:"DELETE"});
      } else {
        result = {ok:false,status:400,body:{error:"La eliminación requiere el id del registro"}};
      }
    } else if(state.action === "upsert") {
      result = await apiFetch(`/api/data/${encodeURIComponent(state.table)}`, {method:"POST", body:JSON.stringify({action:"upsert", data:state.payload, select:state.selectText, single:!!state.single})});
    }
    if(!result.ok) return {data:null,error:{message:result.body?.error || `Error ${result.status}`,detail:result.body?.detail||null,status:result.status}};
    return {data:result.body?.data ?? null,error:null};
  }

  const authListeners = [];
  const sbClient = {
    from(table){ return createQuery(table); },
    auth:{
      async getSession(){
        const token=getToken();
        if(!token) return {data:{session:null},error:null};
        const r=await apiFetch('/api/auth/me');
        if(!r.ok){setToken("");return {data:{session:null},error:null};}
        return {data:{session:{access_token:token,user:r.body.user}},error:null};
      },
      async signInWithPassword({email,password}){
        const r=await apiFetch('/api/auth/login',{method:'POST',body:JSON.stringify({email,password})});
        if(!r.ok) return {data:null,error:{message:r.body?.error||'Credenciales inválidas'}};
        const token = r.body?.session?.access_token || r.body?.access_token || r.body?.token;
        if(!token) return {data:null,error:{message:"La API no devolvió el token de sesión"}};
        setToken(token);
        return {data:{session:{access_token:token,user:r.body.user},user:r.body.user},error:null};
      },
      async signUp({email,password,options={}}){
        const r=await apiFetch('/api/auth/register',{method:'POST',body:JSON.stringify({email,password,...(options.data||{})})});
        if(!r.ok) return {data:null,error:{message:r.body?.error||'No fue posible registrar el usuario'}};
        if(r.body.token) setToken(r.body.token);
        return {data:{session:r.body.token?{access_token:r.body.token,user:r.body.user}:null,user:r.body.user},error:null};
      },
      async signOut(){ setToken(""); authListeners.slice().forEach(cb=>{try{cb("SIGNED_OUT",null);}catch(e){console.error(e);}}); return {error:null}; },
      onAuthStateChange(callback){
        authListeners.push(callback);
        return {data:{subscription:{unsubscribe(){const i=authListeners.indexOf(callback);if(i>=0)authListeners.splice(i,1);}}}};
      }
    }
  };

  const LLAMADA_TYPES = ["Contestada", "No contestada", "Equivocada", "Sin especificar"];
  // Zonas predeterminadas del sistema de cartera.
  const ZONAS = ["San Marcos", "Caucasia", "Caucasia Subsidiada", "Montelíbano", "La Apartada", "Buenavista"];
  // Tipo de gestión realizada en la llamada.
  const TIPOS_GESTION = ["Gestión reporte a Data Crédito y abogados", "Gestión lista de suspensión", "Gestión recuperación de equipo", "Gestión ofreciendo servicio de la empresa", "Gestión actualización de información"];
  const META_POR_DEFECTO = 500;
  let currentUser = null, currentProfile = null, calls = [], advisors = [], surveys = [], seguimientoSurveys = [], servicioSurveys = [], config = { color_principal: "#0ea5e9", logo_url: "" };
  let asesoresSeleccionados = []; // [] = todos los asesores

  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents(); setTodayDefault(); setAdminCallTodayDefault(); showAuthView(); applyTheme();
    toggleWhatsappFields(); toggleCompromisoField(); toggleAdminWhatsappFields(); toggleAdminCompromisoField();
    const { data: { session } } = await sbClient.auth.getSession();
    if (session?.user) await initializeSession(session.user);
    sbClient.auth.onAuthStateChange(async (event, session) => {
      if (event === "SIGNED_OUT") { currentUser = null; currentProfile = null; calls = []; advisors = []; surveys = []; showAuthView(); return; }
      if (session?.user && event !== "INITIAL_SESSION") await initializeSession(session.user);
    });
  });

  function bindEvents() {
    // Vinculación segura: un elemento ausente no debe detener el resto de botones.
    const on = (selector, event, handler) => {
      const el = id(selector);
      if (el) el.addEventListener(event, handler);
    };

    on("login-form", "submit", login);
    on("register-form", "submit", registerAdvisor);
    on("call-form", "submit", registerCall);
    on("admin-call-form", "submit", registerCallAdmin);
    on("seguimiento-form", "submit", saveSeguimientoSurvey);
    on("servicio-form", "submit", saveServicioSurvey);

    on("btn-show-register", "click", () => { id("auth-view")?.classList.add("hidden"); id("register-view")?.classList.remove("hidden"); });
    on("btn-back-login", "click", showAuthView);
    on("btn-logout", "click", logout);
    on("btn-menu", "click", () => id("sidebar")?.classList.toggle("open"));
    on("btn-close-menu", "click", closeSidebar);

    on("filtroAsesor", "input", renderAdvisorTable);
    on("filtroAsesorDesde", "change", renderAdvisorTable);
    on("filtroAsesorHasta", "change", renderAdvisorTable);
    on("btn-limpiar-filtro-asesor", "click", clearAsesorFilters);
    on("whatsappEnviado", "change", toggleWhatsappFields);
    on("compromisoPago", "change", toggleCompromisoField);
    on("adminCallWhatsapp", "change", toggleAdminWhatsappFields);
    on("adminCallCompromiso", "change", toggleAdminCompromisoField);

    ["filtroAdminTexto","filtroLlamadaAdmin","filtroTipoGestionAdmin","filtroCompromisoAdmin","filtroPagoAdmin","filtroZonaAdmin","filtroDesdeAdmin","filtroHastaAdmin"].forEach(x => {
      on(x, "input", renderAdmin);
      on(x, "change", renderAdmin);
    });

    on("ms-asesores-toggle", "click", (e) => { e.stopPropagation(); id("ms-asesores-panel")?.classList.toggle("hidden"); });
    on("ms-asesores-all", "click", () => { asesoresSeleccionados = []; syncAsesoresChecklist(); renderAdmin(); });
    on("ms-asesores-none", "click", () => { asesoresSeleccionados = advisors.map(a => a.id); syncAsesoresChecklist(); renderAdmin(); });
    document.addEventListener("click", (e) => {
      const panel = id("ms-asesores-panel"), box = id("ms-asesores");
      if (panel && !panel.classList.contains("hidden") && box && !box.contains(e.target)) panel.classList.add("hidden");
    });

    on("btn-clear-filters", "click", clearAdminFilters);
    on("btn-preview-report", "click", () => previewReport());
    on("btn-close-report-preview", "click", closeReportPreview);
    on("btn-print-report", "click", () => printReport());
    on("btn-pdf-report", "click", () => downloadPDF());
    on("btn-excel-report", "click", downloadExcel);

    on("btn-preview-advisor-summary", "click", () => previewReport(buildAdvisorSummaryReportHTML));
    on("btn-print-advisor-summary", "click", () => printReport(buildAdvisorSummaryReportHTML));
    on("btn-pdf-advisor-summary", "click", () => downloadPDF(buildAdvisorSummaryReportHTML,"resumen-llamadas-por-asesor"));
    on("btn-excel-advisor-summary", "click", downloadAdvisorSummaryExcel);

    on("admin-user-form", "submit", saveAdminUser);
    on("admin-survey-form", "submit", saveAdminSurvey);
    on("btn-cancel-user-edit", "click", resetUserForm);
    ["filtroEncuestaAsesor","filtroEncuestaDesde","filtroEncuestaHasta","filtroEncuestaTexto"].forEach(x => {
      on(x, "input", renderSurveys);
      on(x, "change", renderSurveys);
    });
    on("btn-clear-survey-filters", "click", clearSurveyFilters);
    on("btn-preview-survey-report", "click", () => previewReport(buildSurveyReportHTML));
    on("btn-print-survey-report", "click", () => printReport(buildSurveyReportHTML));
    on("btn-pdf-survey-report", "click", () => downloadPDF(buildSurveyReportHTML,"reporte-encuestas-cartera"));
    on("btn-excel-survey-report", "click", downloadSurveyExcel);

    on("config-form", "submit", saveConfig);
    on("btn-remove-logo", "click", removeLogo);
    on("change-password-form", "submit", changePassword);
    on("btn-clear-password", "click", clearPasswordForm);
    on("btn-asesor-report", "click", previewAdvisorReport);
    on("btn-asesor-print", "click", printAdvisorReport);
    on("btn-asesor-pdf", "click", downloadAdvisorPDF);
    on("btn-download-backup", "click", downloadBackup);

    document.querySelectorAll("[data-hub-open]").forEach(b => b.addEventListener("click", () => {
      showView(b.dataset.hubOpen);
      setSectionMode(b.dataset.hubOpen, b.dataset.hubMode || "form");
    }));
    document.querySelectorAll("[data-hub-back]").forEach(b => b.addEventListener("click", () => showView("vista-encuestas-hub")));
  }

  function toggleWhatsappFields(){const on=id("whatsappEnviado").value==="true";id("whatsappMensajeGroup").classList.toggle("hidden",!on);id("whatsappRespuestaGroup").classList.toggle("hidden",!on);}
  function toggleCompromisoField(){const on=id("compromisoPago").value==="true";id("fechaCompromisoGroup").classList.toggle("hidden",!on);}

  async function login(e) { e.preventDefault(); const email=value("login-email"), password=id("login-password").value; setButtonBusy(e.submitter,true,"Ingresando..."); const {data,error}=await sbClient.auth.signInWithPassword({email,password}); setButtonBusy(e.submitter,false,"Ingresar"); if(error){showToast(authError(error),true);return;} await initializeSession(data.user); }

  async function registerAdvisor(e) {
    e.preventDefault(); const password=id("reg-password").value, confirm=id("reg-password-confirm").value;
    if(password!==confirm){showToast("Las contraseñas no coinciden.",true);return;} if(password.length<6){showToast("La contraseña debe tener mínimo 6 caracteres.",true);return;}
    const payload={area:"cartera",nombre:value("reg-nombre"),apellido:value("reg-apellido"),documento:value("reg-documento"),telefono:value("reg-telefono"),zona:"",rol:"asesor"};
    setButtonBusy(e.submitter,true,"Registrando..."); const {data,error}=await sbClient.auth.signUp({email:value("reg-email"),password,options:{data:payload}}); setButtonBusy(e.submitter,false,"Registrar asesor");
    if(error){showToast(authError(error),true);return;} id("register-form").reset(); if(data.session){showToast("Asesor registrado correctamente.");await initializeSession(data.user);}else{showToast("Registro creado. Revisa el correo para confirmar la cuenta.");showAuthView();}
  }

  function normalizeRole(value){ return String(value || "").trim().toLowerCase(); }
  function isAdminRole(value){ const role=normalizeRole(value); return role==="administrador" || role==="admin"; }
  function isCurrentAdmin(){ return isAdminRole(currentProfile?.rol); }

  async function initializeSession(user) {
    currentUser=user;

    // El rol autoritativo viene de /api/auth/me (Cloudflare + Neon).
    // Esto evita que un dato antiguo del navegador determine si es asesor o administrador.
    let profile=null;
    let error=null;
    try {
      const me=await apiFetch('/api/auth/me');
      if(me.ok && me.body?.user) profile=me.body.user;
      else error={message:me.body?.error || `Error ${me.status}`};
    } catch(e) { error=e; }

    // Fallback al perfil de la API de datos si /me no estuviera disponible.
    if(!profile){
      const result=await sbClient.from("perfilescr").select("*").eq("id",user.id).single();
      profile=result.data;
      error=result.error;
    }
    if(error){console.error(error);await sbClient.auth.signOut();showToast("No fue posible cargar tu perfil. Ejecuta el SQL de Cartera.",true);return;}
    if(profile.activo === false){await sbClient.auth.signOut();showToast("Tu usuario está inhabilitado. Contacta al administrador.",true);return;}
    profile.rol = normalizeRole(profile.rol);
    currentProfile=profile; await loadConfig(); updateSessionHeader(); buildSidebar();
    if(isAdminRole(profile.rol)){await loadAdminData();showView("admin-dashboard");} else {await loadAdvisorData();showView("vista-asesor");}
  }

  async function loadConfig(){
    const {data,error}=await sbClient.from("configuracioncr").select("color_principal,logo_url").eq("id",1).maybeSingle();
    if(error){console.error("CONFIG ERROR:",error);applyTheme();renderConfig();return;}
    if(data) config=data; applyTheme(); renderConfig();
  }

  async function loadAdvisorData(){
    const [cr,sr,sgr,srr]=await Promise.all([
      sbClient.from("llamadascr").select("*").eq("asesor_id",currentUser.id).order("fecha_llamada",{ascending:false}).order("id",{ascending:false}),
      sbClient.from("encuestascr").select(`*, perfilescr:asesor_id (id,nombre,apellido,zona,email,activo)`).eq("asesor_id",currentUser.id).order("id",{ascending:false}),
      sbClient.from("encuestas_seguimientocr").select("*").eq("asesor_id",currentUser.id).order("id",{ascending:false}),
      sbClient.from("encuestas_serviciocr").select("*").eq("asesor_id",currentUser.id).order("id",{ascending:false})
    ]);
    if(cr.error){console.error(cr.error);showToast("No fue posible cargar tus llamadas.",true);return;}
    calls=cr.data||[]; surveys=sr.data||[]; seguimientoSurveys=sgr.data||[]; servicioSurveys=srr.data||[];
    applyAdvisorProfile();renderAdvisorTable();updateAdvisorDashboard();renderSeguimientoAsesor();renderSurveys();renderSeguimientoSurveys();renderServicioSurveys();
  }

  async function loadAdminData(){
    const [cr,ar,er,sgr,srr]=await Promise.all([
      sbClient.from("llamadascr").select(`*, perfilescr:asesor_id (id,nombre,apellido,zona,email,activo)`).order("fecha_llamada",{ascending:false}).order("id",{ascending:false}),
      sbClient.from("perfilescr").select("*").eq("rol","asesor").order("nombre",{ascending:true}).order("apellido",{ascending:true}),
      sbClient.from("encuestascr").select(`*, perfilescr:asesor_id (id,nombre,apellido,email,rol,activo)`).order("id",{ascending:false}),
      sbClient.from("encuestas_seguimientocr").select("*").order("id",{ascending:false}),
      sbClient.from("encuestas_serviciocr").select("*").order("id",{ascending:false})
    ]);
    if(cr.error){console.error(cr.error);showToast("No fue posible cargar las llamadas.",true);return;} if(ar.error){console.error(ar.error);showToast("No fue posible cargar los asesores.",true);return;}
    if(er.error||sgr.error||srr.error){console.error(er.error||sgr.error||srr.error);showToast("No fue posible cargar las encuestas. Ejecuta el nuevo SQL de migración.",true);return;}
    calls=cr.data||[]; advisors=ar.data||[]; surveys=er.data||[]; seguimientoSurveys=sgr.data||[]; servicioSurveys=srr.data||[]; populateAdminFilters(); populateSurveyFilters(); renderAdmin(); renderSurveys(); renderSeguimientoSurveys(); renderServicioSurveys(); renderUsers(); updateAdminDashboard(); renderConfig();
  }

  async function registerCall(e){
    e.preventDefault(); if(!currentUser||!currentProfile){showToast("Tu sesión no está disponible.",true);return;}
    const whatsapp=id("whatsappEnviado").value==="true", compromiso=id("compromisoPago").value==="true", pago=id("pago").value==="true";
    if(compromiso && !id("fechaCompromiso").value){showToast("Selecciona la fecha del compromiso de pago.",true);return;}
    const zonaSeleccionada=value("zona"); if(!ZONAS.includes(zonaSeleccionada)){showToast("Selecciona una zona válida de la lista.",true);return;}
    const tipoGestionSeleccionado=value("tipoGestion");
    if(!tipoGestionSeleccionado){showToast("Selecciona el tipo de gestión realizada.",true);return;}
    const llamadaSeleccionada=value("tipoLlamada");
    const tipoLlamada=LLAMADA_TYPES.includes(llamadaSeleccionada)?llamadaSeleccionada:"Sin especificar";
    const row={asesor_id:currentUser.id,cliente:value("cliente"),llamada:tipoLlamada,tipo_gestion:tipoGestionSeleccionado,zona:zonaSeleccionada,whatsapp_enviado:whatsapp,whatsapp_mensaje:whatsapp?(value("whatsappMensaje")||null):null,whatsapp_respuesta:whatsapp?(value("whatsappRespuesta")||null):null,compromiso_pago:compromiso,fecha_compromiso:compromiso?id("fechaCompromiso").value:null,pago:pago,observaciones:value("observaciones")||null,fecha_llamada:id("fechaLlamada").value};
    if(!row.cliente||!row.zona||!row.fecha_llamada){showToast("Completa todos los campos obligatorios.",true);return;}
    const {data,error}=await sbClient.from("llamadascr").insert(row).select().single(); if(error){console.error("REGISTRO LLAMADA ERROR:",error);showToast(error.detail ? `${error.message}: ${error.detail}` : (error.message||"No fue posible registrar la llamada."),true);return;}
    e.target.reset();applyAdvisorProfile();setTodayDefault();toggleWhatsappFields();toggleCompromisoField();calls.unshift(data);renderAdvisorTable();updateAdvisorDashboard();renderSeguimientoAsesor();showToast("Llamada registrada correctamente.");
  }

  function toggleAdminWhatsappFields(){const on=id("adminCallWhatsapp").value==="true";id("adminCallWhatsappMensajeGroup").classList.toggle("hidden",!on);id("adminCallWhatsappRespuestaGroup").classList.toggle("hidden",!on);}
  function toggleAdminCompromisoField(){const on=id("adminCallCompromiso").value==="true";id("adminCallFechaCompromisoGroup").classList.toggle("hidden",!on);}

  async function registerCallAdmin(e){
    e.preventDefault(); if(!currentUser||!currentProfile){showToast("Tu sesión no está disponible.",true);return;}
    const whatsapp=id("adminCallWhatsapp").value==="true", compromiso=id("adminCallCompromiso").value==="true", pago=id("adminCallPago").value==="true";
    if(compromiso && !id("adminCallFechaCompromiso").value){showToast("Selecciona la fecha del compromiso de pago.",true);return;}
    const zonaSeleccionada=value("adminCallZona"); if(!ZONAS.includes(zonaSeleccionada)){showToast("Selecciona una zona válida de la lista.",true);return;}
    const tipoGestionSeleccionado=value("adminCallTipoGestion");
    if(!tipoGestionSeleccionado){showToast("Selecciona el tipo de gestión realizada.",true);return;}
    const llamadaSeleccionada=value("adminCallLlamada");
    const tipoLlamada=LLAMADA_TYPES.includes(llamadaSeleccionada)?llamadaSeleccionada:"Sin especificar";
    const row={asesor_id:currentUser.id,cliente:value("adminCallCliente"),llamada:tipoLlamada,tipo_gestion:tipoGestionSeleccionado,zona:zonaSeleccionada,whatsapp_enviado:whatsapp,whatsapp_mensaje:whatsapp?(value("adminCallWhatsappMensaje")||null):null,whatsapp_respuesta:whatsapp?(value("adminCallWhatsappRespuesta")||null):null,compromiso_pago:compromiso,fecha_compromiso:compromiso?id("adminCallFechaCompromiso").value:null,pago:pago,observaciones:value("adminCallObservaciones")||null,fecha_llamada:id("adminCallFecha").value};
    if(!row.cliente||!row.zona||!row.fecha_llamada){showToast("Completa todos los campos obligatorios.",true);return;}
    const {data,error}=await sbClient.from("llamadascr").insert(row).select(`*, perfilescr:asesor_id (id,nombre,apellido,zona,email,activo)`).single();
    if(error){console.error("REGISTRO LLAMADA ERROR:",error);showToast(error.detail ? `${error.message}: ${error.detail}` : (error.message||"No fue posible registrar la llamada."),true);return;}
    e.target.reset();setAdminCallTodayDefault();toggleAdminWhatsappFields();toggleAdminCompromisoField();
    calls.unshift(data);populateAdminFilters();renderAdmin();updateAdminDashboard();showToast("Llamada registrada correctamente.");
  }
  function setAdminCallTodayDefault(){const x=id("adminCallFecha");if(x&&!x.value)x.value=getTodayISO();}

  async function setPago(callId,val){
    if(!currentProfile||!isCurrentAdmin())return;
    const {data,error}=await sbClient.from("llamadascr").update({pago:val}).eq("id",callId).select(`*,perfilescr:asesor_id (id,nombre,apellido,zona,email,activo)`).single();
    if(error){showToast("No fue posible actualizar el pago.",true);return;} updateCallLocal(data); showToast(val?"Marcado como pagado.":"Marcado como no pagado.");
  }
  function updateCallLocal(data){const i=calls.findIndex(x=>x.id===data.id);if(i>=0)calls[i]=data;renderAdmin();updateAdminDashboard();}
  async function deleteCall(callId){if(!confirm("¿Eliminar definitivamente esta llamada? Esta acción no se puede deshacer."))return;const {error}=await sbClient.from("llamadascr").delete().eq("id",callId);if(error){showToast("No fue posible eliminar la llamada. Verifica las políticas RLS.",true);return;}calls=calls.filter(x=>x.id!==callId);renderAdmin();updateAdminDashboard();showToast("Llamada eliminada.");}

  function buildSidebar(){const nav=id("sidebar-nav");const admin=isCurrentAdmin();const items=admin?[ ["admin-dashboard","▦","Dashboard"],["vista-admin","＋","Registrar llamada","form"],["vista-admin","▤","Ver llamadas","report"],["vista-encuestas-hub","☑","Encuestas"],["vista-usuarios","＋","Registrar asesor","form"],["vista-usuarios","▤","Reporte asesores","report"],["vista-configuracion","⚙","Configuración"],["vista-respaldo","⭳","Respaldo"] ]:[["vista-asesor","▦","Mi dashboard"],["vista-asesor","＋","Registrar llamada"],["vista-asesor","▤","Mis llamadas"],["vista-encuestas-hub","☑","Encuestas"]];nav.innerHTML=items.map(([target,icon,label,mode])=>`<button class="nav-item" type="button" data-target="${target}" data-mode="${mode||''}" data-anchor="${target==='vista-asesor'?label:''}"><span>${icon}</span>${label}</button>`).join("");nav.querySelectorAll(".nav-item").forEach(b=>b.addEventListener("click",()=>{showView(b.dataset.target);if(b.dataset.mode)setSectionMode(b.dataset.target,b.dataset.mode);if(b.dataset.anchor==="Registrar llamada")id("asesor-form-section").scrollIntoView({behavior:"smooth"});if(b.dataset.anchor==="Mis llamadas")document.querySelector("#vista-asesor .table-card").scrollIntoView({behavior:"smooth"});closeSidebar();}));applyRoleVisibility();}
  function applyRoleVisibility(){const admin=isCurrentAdmin();document.querySelectorAll(".admin-only").forEach(el=>el.classList.toggle("hidden",!admin));}
  function closeSidebar(){id("sidebar").classList.remove("open");}

  function updateSessionHeader(){const name=[currentProfile?.nombre,currentProfile?.apellido].filter(Boolean).join(" ")||"Usuario", role=isCurrentAdmin()?"Administrador":"Asesor";id("user-name").textContent=name;id("user-role").textContent=role;id("user-avatar").textContent=name.charAt(0).toUpperCase();id("sidebar-user-name").textContent=name;id("sidebar-user-role").textContent=role;id("session-area").classList.remove("hidden");id("btn-menu").classList.remove("hidden");id("sidebar").classList.remove("hidden");}
  function applyAdvisorProfile(){const select=id("zona");if(select){select.innerHTML=`<option value="">Seleccione la zona...</option>`+ZONAS.map(z=>`<option value="${escapeHTML(z)}">${escapeHTML(z)}</option>`).join("");select.value="";}id("asesor-zone-badge").textContent="Zona de trabajo: cualquier zona";id("asesor-welcome").textContent="Registra llamadas y selecciona la zona correspondiente en cada gestión.";}

  function getFilteredAsesorCalls(){const filtro=value("filtroAsesor").toLowerCase(),from=value("filtroAsesorDesde"),to=value("filtroAsesorHasta");return calls.filter(c=>{const matchText=[c.cliente,c.llamada,c.zona,c.observaciones,c.tipo_gestion].join(" ").toLowerCase().includes(filtro);const matchFrom=!from||c.fecha_llamada>=from;const matchTo=!to||c.fecha_llamada<=to;return matchText&&matchFrom&&matchTo;});}
  function clearAsesorFilters(){id("filtroAsesor").value="";id("filtroAsesorDesde").value="";id("filtroAsesorHasta").value="";renderAdvisorTable();}
  function renderAdvisorTable(){const tabla=id("tabla-asesor"),filtered=getFilteredAsesorCalls();tabla.innerHTML=filtered.length?filtered.map(c=>`<tr><td>#${c.id}</td><td>${escapeHTML(c.cliente)}</td><td>${llamadaBadge(c.llamada)}</td><td>${tipoGestionBadge(c.tipo_gestion)}</td><td>${escapeHTML(c.zona)}</td><td>${whatsappBadge(c)}</td><td>${compromisoCell(c)}</td><td>${pagoBadge(c.pago)}</td><td>${formatDate(c.fecha_llamada)}</td></tr>`).join(""):`<tr class="empty-row"><td colspan="9">${calls.length?"No se encontraron llamadas con los filtros seleccionados.":"No hay llamadas registradas."}</td></tr>`;updateAdvisorStats();}
  function updateAdvisorStats(){const total=calls.length,contestadas=calls.filter(c=>c.llamada==="Contestada").length,no=calls.filter(c=>c.llamada==="No contestada").length,pagos=calls.filter(c=>c.pago).length,compromisos=calls.filter(c=>c.compromiso_pago).length;id("asesor-total-count").textContent=total;id("asesor-contestadas-count").textContent=contestadas;id("asesor-nocontestadas-count").textContent=no;id("asesor-pagos-count").textContent=pagos;id("asesor-compromisos-count").textContent=compromisos;const meta=metaDe(currentProfile),pct=metaPct(total,meta);setText("asesor-meta-count",meta);setText("asesor-meta-pct",`${pct}%`);const bar=id("asesor-meta-bar");if(bar)bar.style.width=`${Math.min(100,pct)}%`;}
  function metaDe(p){const n=Number(p?.meta_mensual ?? p?.meta_llamadas);return Number.isFinite(n)&&n>0?n:META_POR_DEFECTO;}
  function metaPct(hechas,meta){return meta>0?Math.round(hechas/meta*100):0;}
  function updateAdvisorDashboard(){updateAdvisorStats();}

  function renderAdmin(){const filtered=getFilteredAdminCalls();const summaryBody=id("tabla-admin");const detailBody=id("tabla-admin-detail");const by={};filtered.forEach(c=>{const a=c.perfilescr||{},name=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"—";const k=c.asesor_id||name;if(!by[k])by[k]={name,total:0,contestadas:0,no:0,whatsapp:0,compromisos:0,pagos:0,zones:new Set()};const g=by[k];g.total++;if(c.llamada==="Contestada")g.contestadas++;if(c.llamada==="No contestada")g.no++;if(c.whatsapp_enviado)g.whatsapp++;if(c.compromiso_pago)g.compromisos++;if(c.pago)g.pagos++;if(c.zona)g.zones.add(c.zona);});const rows=Object.values(by).sort((a,b)=>b.total-a.total);if(summaryBody)summaryBody.innerHTML=rows.length?rows.map(g=>`<tr><td><strong>${escapeHTML(g.name)}</strong></td><td>${g.total}</td><td><span class="metric-pill metric-ok">${g.contestadas}</span></td><td><span class="metric-pill metric-no">${g.no}</span></td><td><span class="metric-pill metric-wa">${g.whatsapp}</span></td><td>${g.compromisos}</td><td>${g.pagos}</td><td>${escapeHTML([...g.zones].join(", ")||"—")}</td></tr>`).join(""):'<tr class="empty-row"><td colspan="8">No hay llamadas con los filtros seleccionados.</td></tr>';if(detailBody)detailBody.innerHTML=filtered.length?filtered.map(c=>{const a=c.perfilescr||{},name=[a.nombre,a.apellido].filter(Boolean).join(" ")||"—";return `<tr><td>#${c.id}</td><td>${escapeHTML(name)}</td><td>${escapeHTML(c.cliente)}</td><td>${llamadaBadge(c.llamada)}</td><td>${tipoGestionBadge(c.tipo_gestion)}</td><td>${escapeHTML(c.zona)}</td><td>${whatsappBadge(c)}</td><td>${compromisoCell(c)}</td><td class="action-cell">${pagoBadge(c.pago)}<button class="btn-small" onclick="setPago(${c.id},${!c.pago})">${c.pago?"Quitar pago":"Marcar pago"}</button></td><td>${formatDate(c.fecha_llamada)}</td><td class="action-cell"><button class="btn-delete" onclick="deleteCall(${c.id})">Eliminar</button></td></tr>`;}).join(""):'<tr class="empty-row"><td colspan="11">No hay llamadas registradas.</td></tr>';setText("admin-result-count",`${filtered.length} llamada${filtered.length===1?"":"s"}`);renderSeguimientoAdmin();}
   function getFilteredAdminCalls(){const text=value("filtroAdminTexto").toLowerCase(),llamada=id("filtroLlamadaAdmin").value,tipoGestion=id("filtroTipoGestionAdmin").value,compromiso=id("filtroCompromisoAdmin").value,pago=id("filtroPagoAdmin").value,zona=id("filtroZonaAdmin").value,from=id("filtroDesdeAdmin").value,to=id("filtroHastaAdmin").value;return calls.filter(c=>{const a=c.perfilescr||{},search=[a.nombre,a.apellido,a.email,c.cliente,c.zona,c.observaciones,c.llamada,c.tipo_gestion].join(" ").toLowerCase();return(!text||search.includes(text))&&(!asesoresSeleccionados.length||asesoresSeleccionados.includes(c.asesor_id))&&(!llamada||c.llamada===llamada)&&(!tipoGestion||c.tipo_gestion===tipoGestion)&&(!compromiso||String(c.compromiso_pago)===compromiso)&&(!pago||String(c.pago)===pago)&&(!zona||c.zona===zona)&&(!from||c.fecha_llamada>=from)&&(!to||c.fecha_llamada<=to);});}
  function populateAdminFilters(){const zone=id("filtroZonaAdmin"),zVal=zone.value;zone.innerHTML='<option value="">Todas las zonas</option>'+ZONAS.map(z=>`<option>${escapeHTML(z)}</option>`).join("");zone.value=zVal;const tg=id("filtroTipoGestionAdmin"),tgVal=tg.value;tg.innerHTML='<option value="">Todos</option>'+TIPOS_GESTION.map(t=>`<option>${escapeHTML(t)}</option>`).join("");tg.value=tgVal;asesoresSeleccionados=asesoresSeleccionados.filter(id=>advisors.some(a=>a.id===id));syncAsesoresChecklist();}
  function syncAsesoresChecklist(){
    const list=id("ms-asesores-list"); if(!list)return;
    list.innerHTML=advisors.map(a=>{const nombre=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email;const checked=asesoresSeleccionados.includes(a.id)?"checked":"";return `<label class="multiselect-option"><input type="checkbox" value="${a.id}" ${checked}> ${escapeHTML(nombre)}</label>`;}).join("")||'<p class="muted">No hay asesores registrados.</p>';
    list.querySelectorAll('input[type="checkbox"]').forEach(chk=>chk.addEventListener("change",()=>{
      const id_=chk.value;
      if(chk.checked){if(!asesoresSeleccionados.includes(id_))asesoresSeleccionados.push(id_);}else{asesoresSeleccionados=asesoresSeleccionados.filter(x=>x!==id_);}
      updateAsesoresToggleLabel();renderAdmin();
    }));
    updateAsesoresToggleLabel();
  }
  function updateAsesoresToggleLabel(){
    const btn=id("ms-asesores-toggle"); if(!btn)return;
    if(!asesoresSeleccionados.length){btn.textContent="Todos los asesores";return;}
    if(asesoresSeleccionados.length===1){const a=advisors.find(x=>x.id===asesoresSeleccionados[0]);btn.textContent=a?([a.nombre,a.apellido].filter(Boolean).join(" ")||a.email):"1 asesor seleccionado";return;}
    btn.textContent=`${asesoresSeleccionados.length} asesores seleccionados`;
  }
  function nombreAsesor(a){return [a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Sin asesor";}
  function asesoresComparadosTexto(){return asesoresSeleccionados.length?advisors.filter(a=>asesoresSeleccionados.includes(a.id)).map(nombreAsesor).join(", "):"Todos los asesores";}

  function updateAdminDashboard(){
    const total=calls.length,contestadas=calls.filter(c=>c.llamada==="Contestada").length,no=calls.filter(c=>c.llamada==="No contestada").length,compromisos=calls.filter(c=>c.compromiso_pago).length,pagos=calls.filter(c=>c.pago).length;
    setText("dash-total",total);setText("dash-contestadas",contestadas);setText("dash-nocontestadas",no);setText("dash-compromisos",compromisos);setText("dash-pagos",pagos);
    const now=new Date(),ym=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`,monthly=calls.filter(c=>c.fecha_llamada?.startsWith(ym));
    const metaTotal=advisors.filter(a=>a.activo!==false).reduce((acc,a)=>acc+metaDe(a),0),adminPct=metaPct(monthly.length,metaTotal);
    setText("dash-admin-goal",metaTotal);setText("dash-admin-goal-done",monthly.length);setText("dash-admin-goal-pct",`${adminPct}%`);
    const bar=id("dash-admin-goal-bar");if(bar)bar.style.width=`${Math.min(100,adminPct)}%`;
    setText("dash-admin-goal-month",new Date(now.getFullYear(),now.getMonth(),1).toLocaleDateString("es-CO",{month:"long",year:"numeric"}));
    id("dash-goals-list").innerHTML=advisors.filter(a=>a.activo!==false).map(a=>{const n=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email,count=monthly.filter(c=>c.asesor_id===a.id).length,meta=metaDe(a),pct=metaPct(count,meta);return `<div class="goal-chart-row"><div class="goal-chart-head"><strong>${escapeHTML(n)}</strong><span>${count} de ${meta} llamadas · ${pct}%</span></div><div class="goal-track"><i style="width:${Math.min(100,pct)}%"></i></div></div>`;}).join("")||'<p class="muted">No hay asesores registrados.</p>';
    const counts=[...LLAMADA_TYPES.map(t=>({t,n:monthly.filter(c=>c.llamada===t).length})),{t:"Compromisos",n:monthly.filter(c=>c.compromiso_pago).length},{t:"Pagos",n:monthly.filter(c=>c.pago).length}];const max=Math.max(1,...counts.map(x=>x.n));id("dash-services-list").innerHTML=counts.map(x=>`<div class="mini-bar-row"><span>${x.t}</span><div><i style="width:${x.n/max*100}%"></i></div><strong>${x.n}</strong></div>`).join("");
    const gestionCounts=TIPOS_GESTION.map(t=>({t,n:monthly.filter(c=>c.tipo_gestion===t).length}));const gestionMax=Math.max(1,...gestionCounts.map(x=>x.n));id("dash-gestion-list").innerHTML=gestionCounts.map(x=>`<div class="mini-bar-row"><span title="${escapeHTML(x.t)}">${escapeHTML(TIPOS_GESTION_CORTO[x.t]||x.t)}</span><div><i style="width:${x.n/gestionMax*100}%"></i></div><strong>${x.n}</strong></div>`).join("");
  }

  function renderUsers(){const tbody=id("tabla-usuarios");if(!tbody)return;tbody.innerHTML=advisors.map(a=>{const name=[a.nombre,a.apellido].filter(Boolean).join(" ")||"—";const meta=metaDe(a),hechas=calls.filter(c=>c.asesor_id===a.id).length,pct=metaPct(hechas,meta);return `<tr><td><strong>${escapeHTML(name)}</strong></td><td>${escapeHTML(a.email||"—")}</td><td>${meta}</td><td>${hechas}</td><td><div class="mini-progress"><span style="width:${Math.min(100,pct)}%"></span></div><small>${pct}%</small></td><td>${a.activo===false?'<span class="badge badge-disabled">Inhabilitado</span>':'<span class="badge badge-active">Activo</span>'}</td><td class="action-cell"><button class="btn-small" onclick="editAdvisor('${a.id}')">Editar</button><button class="btn-small" onclick="toggleAdvisor('${a.id}',${a.activo!==false})">${a.activo===false?"Habilitar":"Inhabilitar"}</button><button class="btn-delete" onclick="deleteAdvisor('${a.id}')">Eliminar</button></td></tr>`;}).join("")||'<tr class="empty-row"><td colspan="7">No hay asesores registrados.</td></tr>';}

  function resetAdminSurveyForm(){
    const form=id("admin-survey-form"); if(form)form.reset();
  }

  async function saveAdminSurvey(e){
    e.preventDefault();
    if(!currentUser||!currentProfile){showToast("Tu sesión no está disponible.",true);return;}
    const enc={
      llamada_id:null,
      asesor_id:currentUser.id,
      codigo_usuario:value("adminEncCodigoUsuario")||null,
      calificacion_servicio:value("adminEncServicio")||null,
      observacion_servicio:value("adminEncServicioObs")||null,
      calificacion_tecnica:value("adminEncTecnica")||null,
      observacion_tecnica:value("adminEncTecnicaObs")||null,
      calificacion_administrativa:value("adminEncAdministrativa")||null,
      observacion_administrativa:value("adminEncAdministrativaObs")||null,
      agilidad_averias:value("adminEncAverias")||null,
      recomendaria:value("adminEncRecomendaria")||null,
      recomendacion_felicitacion:value("adminEncRecomendacion")||null
    };
    if(!enc.codigo_usuario){showToast("Escribe el nombre del cliente o usuario encuestado.",true);return;}
    setButtonBusy(e.submitter,true,"Guardando...");
    const {data,error}=await sbClient.from("encuestascr").insert(enc).select(`*, perfilescr:asesor_id (id,nombre,apellido,email,rol,activo)`).single();
    setButtonBusy(e.submitter,false,"Guardar encuesta");
    if(error){console.error(error);showToast(error.message||"No fue posible guardar la encuesta.",true);return;}
    surveys.unshift(data); populateSurveyFilters(); renderSurveys(); resetAdminSurveyForm(); showToast("Encuesta del administrador guardada correctamente.");
  }


  async function saveSeguimientoSurvey(e){e.preventDefault();const row={usuario:value("segUsuario"),como_se_entero:value("segEntero")||null,fechas_pago:value("segFechas"),medio_contrato:value("segContrato"),atencion_asesor:value("segAtencion"),redes_sociales:value("segRedes"),cobro_tecnico:value("segTecnica"),medios_pago:value("segMedios"),asesor_id:currentUser.id};const {data,error}=await sbClient.from("encuestas_seguimientocr").insert(row).select().single();if(error){showToast(error.message,true);return;}seguimientoSurveys.unshift(data);renderSeguimientoSurveys();e.target.reset();showToast("Encuesta de seguimiento guardada.");}
  async function saveServicioSurvey(e){e.preventDefault();const row={usuario:value("srvUsuario"),servicio_retirado:value("srvServicio"),motivo_retiro:value("srvMotivo")||null,interes_retomar:value("srvRetomar"),observaciones:value("srvObservaciones")||null,asesor_id:currentUser.id};const {data,error}=await sbClient.from("encuestas_serviciocr").insert(row).select().single();if(error){showToast(error.message,true);return;}servicioSurveys.unshift(data);renderServicioSurveys();e.target.reset();showToast("Encuesta de servicio guardada.");}
  function renderSeguimientoSurveys(){const t=id("tabla-seguimiento-encuesta");if(!t)return;t.innerHTML=seguimientoSurveys.map(x=>`<tr><td>${escapeHTML(x.usuario)}</td><td>${escapeHTML(x.como_se_entero||"—")}</td><td>${escapeHTML(x.fechas_pago)}</td><td>${escapeHTML(x.medio_contrato)}</td><td>${escapeHTML(x.atencion_asesor)}</td><td>${escapeHTML(x.redes_sociales)}</td><td>${escapeHTML(x.cobro_tecnico)}</td><td>${escapeHTML(x.medios_pago)}</td><td>${formatDate(x.created_at?.slice(0,10))}</td></tr>`).join("")||'<tr class="empty-row"><td colspan="10">No hay encuestas registradas.</td></tr>';}
  function renderServicioSurveys(){const t=id("tabla-servicio-encuesta");if(!t)return;t.innerHTML=servicioSurveys.map(x=>`<tr><td>${formatDate(surveyDate(x))}</td><td>${escapeHTML(surveyAdvisorName(x))}</td><td>${escapeHTML(x.usuario)}</td><td>${escapeHTML(x.servicio_retirado)}</td><td>${escapeHTML(x.motivo_retiro||"—")}</td><td>${escapeHTML(x.interes_retomar)}</td><td>${escapeHTML(x.observaciones||"—")}</td></tr>`).join("")||'<tr class="empty-row"><td colspan="7">No hay encuestas registradas.</td></tr>';}
  function downloadSimpleCSV(name,rows){if(!rows.length){showToast("No hay datos para exportar.",true);return;}const keys=Object.keys(rows[0]).filter(k=>!["id","asesor_id"].includes(k));const csv=[keys.join(","),...rows.map(r=>keys.map(k=>`"${String(r[k]??"").replaceAll('"','""')}"`).join(","))].join("\n");const a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+csv],{type:"text/csv;charset=utf-8"}));a.download=`reporte_${name}.csv`;a.click();}

  async function saveAdminUser(e){e.preventDefault();const idUser=id("admin-user-id").value;const body={nombre:value("admin-user-nombre"),apellido:value("admin-user-apellido"),documento:value("admin-user-documento"),telefono:value("admin-user-telefono"),zona:"",email:value("admin-user-email"),meta_mensual:Math.max(0,parseInt(id("admin-user-meta").value,10)||META_POR_DEFECTO)};if(!idUser){const password=id("admin-user-password").value;if(password.length<6){showToast("La contraseña debe tener mínimo 6 caracteres.",true);return;}const {data,error}=await fetchAdminFunction("create",{...body,password});if(error){showToast(error,true);return;}showToast("Asesor creado correctamente.");resetUserForm();await loadAdminData();return;}const result=await fetchAdminFunction("update",{user_id:idUser,...body});if(result.error){showToast(result.error,true);return;}showToast("Asesor actualizado.");resetUserForm();await loadAdminData();}
  async function fetchAdminFunction(action,payload){const {data:{session}}=await sbClient.auth.getSession();if(!session)return{error:"Sesión no disponible."};try{const r=await fetch(`${SUPABASE_URL}/functions/v1/admin-users-cr`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.access_token}`},body:JSON.stringify({action,...payload})});const j=await r.json().catch(()=>({}));return r.ok?{data:j}:{error:j.error||`Error ${r.status}`};}catch(e){return{error:"No se pudo contactar la función de administración. Debes desplegar supabase/functions/admin-users-cr."};}}
  function editAdvisor(uid){const a=advisors.find(x=>x.id===uid);if(!a)return;id("admin-user-id").value=a.id;["nombre","apellido","documento","telefono","email"].forEach(k=>id(`admin-user-${k}`).value=a[k]||"");id("admin-user-meta").value=metaDe(a);id("admin-user-password").value="";id("btn-save-user").textContent="Actualizar asesor";id("btn-cancel-user-edit").classList.remove("hidden");setSectionMode("vista-usuarios","form");document.getElementById("vista-usuarios").scrollIntoView({behavior:"smooth"});}
  function resetUserForm(){id("admin-user-form").reset();id("admin-user-id").value="";id("admin-user-meta").value=META_POR_DEFECTO;id("btn-save-user").textContent="Crear asesor";id("btn-cancel-user-edit").classList.add("hidden");}
  async function toggleAdvisor(uid,active){const {error}=await sbClient.from("perfilescr").update({activo:!active}).eq("id",uid);if(error){showToast(error.message,true);return;}showToast(active?"Asesor inhabilitado.":"Asesor habilitado.");await loadAdminData();}
  async function deleteAdvisor(uid){const a=advisors.find(x=>x.id===uid);if(!a)return;if(!confirm(`¿Eliminar a ${[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email}? Solo se podrá eliminar si no tiene llamadas registradas.`))return;const result=await fetchAdminFunction("delete",{user_id:uid});if(result.error){showToast(result.error,true);return;}showToast("Asesor eliminado.");await loadAdminData();}

  async function changePassword(e){
    e.preventDefault();
    if(!currentUser){showToast("Tu sesión no está disponible.",true);return;}
    const currentPassword=id("current-password").value;
    const newPassword=id("new-password").value;
    const confirmPassword=id("confirm-new-password").value;
    if(newPassword.length<6){showToast("La nueva contraseña debe tener mínimo 6 caracteres.",true);return;}
    if(newPassword!==confirmPassword){showToast("Las nuevas contraseñas no coinciden.",true);return;}
    const button=e.submitter;
    setButtonBusy(button,true,"Actualizando...");
    try{
      const r=await apiFetch("/api/auth/change-password",{method:"POST",body:JSON.stringify({currentPassword,newPassword,confirmPassword})});
      if(!r.ok){showToast(r.body?.error||"No fue posible cambiar la contraseña.",true);return;}
      id("change-password-form").reset();
      showToast("Contraseña cambiada correctamente.");
    }catch(error){console.error(error);showToast("No fue posible cambiar la contraseña.",true);}
    finally{setButtonBusy(button,false,"Cambiar contraseña");}
  }
  function clearPasswordForm(){const form=id("change-password-form");if(form)form.reset();}

  async function saveConfig(e){e.preventDefault();let logo=config.logo_url||"";const file=id("config-logo").files[0];if(file){if(file.size>2*1024*1024){showToast("La imagen debe pesar máximo 2 MB.",true);return;}logo=await fileToDataURL(file);}const color=id("config-color").value;const {error}=await sbClient.from("configuracioncr").upsert({id:1,color_principal:color,logo_url:logo,updated_by:currentUser.id},{onConflict:"id"});if(error){showToast(error.message,true);return;}config={color_principal:color,logo_url:logo};applyTheme();renderConfig();showToast("Configuración guardada.");}
  async function removeLogo(){const {error}=await sbClient.from("configuracioncr").upsert({id:1,color_principal:config.color_principal,logo_url:"",updated_by:currentUser.id},{onConflict:"id"});if(error){showToast(error.message,true);return;}config.logo_url="";renderConfig();showToast("Imagen retirada del reporte.");}
  function renderConfig(){id("config-color").value=config.color_principal||"#0ea5e9";id("logo-preview").innerHTML=config.logo_url?`<img src="${config.logo_url}" alt="Logo de empresa">`:'<span>LOGO</span>';}
  function applyTheme(){document.documentElement.style.setProperty("--purple-primary",config.color_principal||"#0ea5e9");}

  function clearAdminFilters(){["filtroAdminTexto","filtroLlamadaAdmin","filtroTipoGestionAdmin","filtroCompromisoAdmin","filtroPagoAdmin","filtroZonaAdmin","filtroDesdeAdmin","filtroHastaAdmin"].forEach(x=>id(x).value="");asesoresSeleccionados=[];syncAsesoresChecklist();renderAdmin();}

  function groupByClient(list){const map={};list.forEach(c=>{if(!map[c.cliente])map[c.cliente]={total:0,contestadas:0,nocontestadas:0,compromisos:0,pagos:0,asesores:new Set()};const g=map[c.cliente];g.total++;if(c.llamada==="Contestada")g.contestadas++;if(c.llamada==="No contestada")g.nocontestadas++;if(c.compromiso_pago)g.compromisos++;if(c.pago)g.pagos++;const a=c.perfilescr;if(a)g.asesores.add([a.nombre,a.apellido].filter(Boolean).join(" ")||a.email);});return map;}
  function renderSeguimientoAsesor(){const now=new Date(),ym=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`,monthly=calls.filter(c=>c.fecha_llamada?.startsWith(ym));const map=groupByClient(monthly);const rows=Object.entries(map).sort((a,b)=>b[1].total-a[1].total);const tbody=id("tabla-seguimiento-asesor");if(!tbody)return;tbody.innerHTML=rows.length?rows.map(([cliente,g])=>`<tr><td>${escapeHTML(cliente)}</td><td>${g.total}</td><td>${g.contestadas}</td><td>${g.nocontestadas}</td><td>${g.compromisos}</td><td>${g.pagos}</td></tr>`).join(""):'<tr class="empty-row"><td colspan="6">No hay llamadas este mes.</td></tr>';}
  function renderSeguimientoAdmin(){const filtered=getFilteredAdminCalls();const map=groupByClient(filtered);const rows=Object.entries(map).sort((a,b)=>b[1].total-a[1].total);const tbody=id("tabla-seguimiento-admin");if(!tbody)return;tbody.innerHTML=rows.length?rows.map(([cliente,g])=>`<tr><td>${escapeHTML(cliente)}</td><td>${g.total}</td><td>${g.contestadas}</td><td>${g.nocontestadas}</td><td>${g.compromisos}</td><td>${g.pagos}</td><td>${escapeHTML([...g.asesores].join(", ")||"—")}</td></tr>`).join(""):'<tr class="empty-row"><td colspan="7">No hay llamadas con los filtros seleccionados.</td></tr>';}

  function metasResumen(list){
    const now=new Date(),ym=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;
    const monthly=calls.filter(c=>c.fecha_llamada?.startsWith(ym));
    return advisors.filter(a=>a.activo!==false).map(a=>{
      const nombre=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"—",meta=metaDe(a),hechas=monthly.filter(c=>c.asesor_id===a.id).length;
      return {nombre,meta,hechas,pct:metaPct(hechas,meta),pendientes:Math.max(0,meta-hechas)};
    }).sort((x,y)=>y.pct-x.pct);
  }
  function metasTablaHTML(list){const filas=metasResumen(list);if(!filas.length)return "";const tot=filas.reduce((acc,f)=>({meta:acc.meta+f.meta,hechas:acc.hechas+f.hechas}),{meta:0,hechas:0});return `<section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">METAS</span><h2>Cumplimiento de metas por asesor</h2></div><strong>${metaPct(tot.hechas,tot.meta)}% global</strong></div><div class="goal-chart print-goal-chart">${filas.map(f=>`<div class="goal-chart-row"><div class="goal-chart-head"><strong>${escapeHTML(f.nombre)}</strong><span>${f.hechas} / ${f.meta} llamadas · ${f.pct}%</span></div><div class="goal-track"><i style="width:${Math.min(100,f.pct)}%"></i></div></div>`).join("")}</div><div class="print-table-scroll"><table><thead><tr><th>Asesor</th><th>Meta</th><th>Llamadas realizadas</th><th>Pendientes</th><th>% de cumplimiento</th></tr></thead><tbody>${filas.map(f=>`<tr><td>${escapeHTML(f.nombre)}</td><td>${f.meta}</td><td>${f.hechas}</td><td>${f.pendientes}</td><td>${f.pct}%</td></tr>`).join("")}<tr><td><strong>TOTAL</strong></td><td><strong>${tot.meta}</strong></td><td><strong>${tot.hechas}</strong></td><td><strong>${Math.max(0,tot.meta-tot.hechas)}</strong></td><td><strong>${metaPct(tot.hechas,tot.meta)}%</strong></td></tr></tbody></table></div></section>`;}

  function advisorCallSummary(list){
    const groups={};
    (list||[]).forEach(c=>{
      const a=c.perfilescr||{};
      const name=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Sin asesor";
      const key=c.asesor_id||name;
      if(!groups[key]) groups[key]={name,total:0,contestadas:0,no:0,equivocadas:0,whatsapp:0,compromisos:0,pagos:0,zones:new Set()};
      const g=groups[key];
      g.total++;
      if(c.llamada==="Contestada") g.contestadas++;
      if(c.llamada==="No contestada") g.no++;
      if(c.llamada==="Equivocada") g.equivocadas++;
      if(c.whatsapp_enviado) g.whatsapp++;
      if(c.compromiso_pago) g.compromisos++;
      if(c.pago) g.pagos++;
      if(c.zona) g.zones.add(c.zona);
    });
    return Object.values(groups).sort((a,b)=>b.total-a.total);
  }

  // ---------------------------------------------------------------
  // Gráficos en SVG puro para PDF/impresión (html2canvas no renderiza
  // bien conic-gradient de CSS; SVG sí se rasteriza de forma fiable).
  // ---------------------------------------------------------------
  function svgDonut(segments, centerLabel, centerSub) {
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    const r = 42, cx = 55, cy = 55, circumference = 2 * Math.PI * r;
    let offset = 0;
    const arcs = segments.filter(s => s.value > 0).map(s => {
      const frac = s.value / total, dash = frac * circumference, gap = circumference - dash;
      const circle = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="15" stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${cx} ${cy})"/>`;
      offset += dash; return circle;
    }).join("");
    return `<svg viewBox="0 0 110 110" width="108" height="108">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eee8f7" stroke-width="15"/>
      ${arcs}
      <text x="${cx}" y="${cy - 1}" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#3c3157">${escapeHTML(centerLabel)}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-family="Arial" font-size="7" fill="#77717f">${escapeHTML(centerSub || "")}</text>
    </svg>`;
  }
  function donutCardHTML(title, segments, centerLabel, centerSub) {
    const legend = segments.map(s => `<span><i class="print-dot" style="background:${s.color}"></i>${escapeHTML(s.label)}<strong>${s.value}</strong></span>`).join("");
    return `<div class="print-chart-card"><h2>${escapeHTML(title)}</h2><div class="print-chart-figure">${svgDonut(segments, centerLabel, centerSub)}<div class="print-legend">${legend}</div></div></div>`;
  }
  function svgBarCompare(items, width) {
    const w = width || 520, leftW = 108, rightW = 34, barH = 15, gap = 8;
    const max = Math.max(1, ...items.map(i => Math.max(i.value, i.value2 || 0)));
    const chartW = w - leftW - rightW;
    const rowH = (items[0] && items[0].value2 !== undefined) ? barH * 2 + 4 : barH;
    const rows = items.map((it, i) => {
      const y = i * (rowH + gap);
      const w1 = Math.max(0, Math.round((it.value / max) * chartW));
      let extra = "";
      if (it.value2 !== undefined) {
        const w2 = Math.max(0, Math.round((it.value2 / max) * chartW));
        extra = `<rect x="${leftW}" y="${y + barH + 3}" width="${chartW}" height="${barH}" rx="4" fill="#efe9f8"/><rect x="${leftW}" y="${y + barH + 3}" width="${w2}" height="${barH}" rx="4" fill="#d7cdef"/><text x="${leftW + chartW + 6}" y="${y + barH + 3 + barH - 4}" font-family="Arial" font-size="8.5" font-weight="700" fill="#7659a9">${it.value2}</text>`;
      }
      return `<text x="0" y="${y + barH - 4}" font-family="Arial" font-size="8.5" fill="#3c3157">${escapeHTML(it.label)}</text>
        <rect x="${leftW}" y="${y}" width="${chartW}" height="${barH}" rx="4" fill="#efe9f8"/>
        <rect x="${leftW}" y="${y}" width="${w1}" height="${barH}" rx="4" fill="${it.color || "#8064b3"}"/>
        <text x="${leftW + chartW + 6}" y="${y + barH - 4}" font-family="Arial" font-size="8.5" font-weight="700" fill="#3c3157">${it.value}</text>
        ${extra}`;
    }).join("");
    const height = items.length ? items.length * (rowH + gap) - gap + 4 : 30;
    return items.length ? `<svg viewBox="0 0 ${w} ${height}" width="100%" height="${height}">${rows}</svg>` : '<p class="print-empty-chart">No hay datos para comparar.</p>';
  }
  function finalGoalBannerHTML(metaTotal, done, pct) {
    return `<div class="print-final-goal">
      <div class="print-final-goal-title"><span>META FINAL DEL ADMINISTRADOR</span><strong>Meta mensual del equipo de cartera</strong></div>
      <div class="print-final-goal-metric"><span>Realizadas</span><strong>${done}</strong></div>
      <div class="print-final-goal-metric"><span>Meta</span><strong>${metaTotal}</strong></div>
      <div class="print-final-goal-metric"><span>Cumplimiento</span><strong>${pct}%</strong></div>
      <div class="print-final-goal-track"><i style="width:${Math.min(100, pct)}%"></i></div>
    </div>`;
  }

  function buildReportHTML(){
    const filtered=getFilteredAdminCalls(),total=filtered.length,contestadas=filtered.filter(c=>c.llamada==="Contestada").length,no=filtered.filter(c=>c.llamada==="No contestada").length,equivocadas=filtered.filter(c=>c.llamada==="Equivocada").length,sinEspecificar=filtered.filter(c=>!c.llamada||c.llamada==="Sin especificar").length,compromisos=filtered.filter(c=>c.compromiso_pago).length,pagos=filtered.filter(c=>c.pago).length;
    const now=new Date(),ym=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`,monthlyCalls=calls.filter(c=>c.fecha_llamada?.startsWith(ym)),metaTotal=advisors.filter(a=>a.activo!==false).reduce((acc,a)=>acc+metaDe(a),0),monthlyPct=metaPct(monthlyCalls.length,metaTotal);
    const desde=value("filtroDesdeAdmin"),hasta=value("filtroHastaAdmin"),period=desde||hasta?`${desde?formatDate(desde):"Inicio"} – ${hasta?formatDate(hasta):"Actual"}`:"Todos los periodos";
    const comparativo=advisorCallSummary(filtered).slice(0,8).map(g=>({label:g.name,value:g.total,color:"#8064b3"}));
    const gestionItems=TIPOS_GESTION.map(t=>({label:TIPOS_GESTION_CORTO[t]||t,value:filtered.filter(c=>c.tipo_gestion===t).length,color:"#0ea5e9"}));
    return `<div class="print-report-sheet compact-pdf">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">REPORTE DE CARTERA</span><h1>Llamadas de cobro</h1><p>Periodo: <strong>${escapeHTML(period)}</strong> · Asesores: <strong>${escapeHTML(asesoresComparadosTexto())}</strong></p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Total llamadas</span><strong>${total}</strong></div><div class="print-summary-card"><span>Contestadas</span><strong>${contestadas}</strong></div><div class="print-summary-card"><span>No contestadas</span><strong>${no}</strong></div><div class="print-summary-card"><span>Equivocadas</span><strong>${equivocadas}</strong></div><div class="print-summary-card"><span>Compromisos</span><strong>${compromisos}</strong></div><div class="print-summary-card"><span>Pagos</span><strong>${pagos}</strong></div></div><section class="print-charts">${donutCardHTML("Tipo de llamada",[{label:"Contestada",value:contestadas,color:"#2ecc71"},{label:"No contestada",value:no,color:"#e74c3c"},{label:"Equivocada",value:equivocadas,color:"#f1c40f"},{label:"Sin especificar",value:sinEspecificar,color:"#9b8fb5"}],total,"total")}${donutCardHTML("Compromisos y pagos",[{label:"Pagos",value:pagos,color:"#2ecc71"},{label:"Compromisos",value:compromisos,color:"#8064b3"}],`${total?Math.round(pagos/total*100):0}%`,"pagaron")}<div class="print-chart-card"><h2>Comparativo por asesor</h2>${svgBarCompare(comparativo)}</div><div class="print-chart-card" style="grid-column:1 / -1"><h2>Tipo de llamada (gestión)</h2>${svgBarCompare(gestionItems,900)}</div></section><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">CLASIFICACIÓN</span><h2>Resultado de llamadas, compromisos y pagos</h2></div><strong>${total} llamadas</strong></div><div class="print-table-scroll"><table><thead><tr><th>Clasificación</th><th>Cantidad</th><th>% del total</th></tr></thead><tbody><tr><td>Contestadas</td><td>${contestadas}</td><td>${total?Math.round(contestadas/total*100):0}%</td></tr><tr><td>No contestadas</td><td>${no}</td><td>${total?Math.round(no/total*100):0}%</td></tr><tr><td>Equivocadas</td><td>${equivocadas}</td><td>${total?Math.round(equivocadas/total*100):0}%</td></tr><tr><td>Sin especificar</td><td>${sinEspecificar}</td><td>${total?Math.round(sinEspecificar/total*100):0}%</td></tr><tr><td>Con compromiso de pago</td><td>${compromisos}</td><td>${total?Math.round(compromisos/total*100):0}%</td></tr><tr><td>Con pago registrado</td><td>${pagos}</td><td>${total?Math.round(pagos/total*100):0}%</td></tr></tbody></table></div></section>${finalGoalBannerHTML(metaTotal,monthlyCalls.length,monthlyPct)}</div>`;
  }
  function previewReport(builder=buildReportHTML){const modal=id("report-preview-modal"),content=id("report-preview-content");if(!modal||!content){showToast("No se encontró el visor de reportes.",true);return;}try{content.innerHTML=builder();modal.classList.remove("hidden");modal.setAttribute("aria-hidden","false");document.body.classList.add("report-preview-open");}catch(e){console.error(e);showToast("No fue posible preparar la vista previa.",true);}}
  function closeReportPreview(){const modal=id("report-preview-modal");if(!modal)return;modal.classList.add("hidden");modal.setAttribute("aria-hidden","true");document.body.classList.remove("report-preview-open");}
  function printReport(builder=buildReportHTML){try{const html=builder();const w=window.open("","_blank","width=1200,height=850");if(!w){showToast("El navegador bloqueó la ventana de impresión. Permite ventanas emergentes para este sitio.",true);return;}const css=document.querySelector('link[href*="styles.css"]');w.document.open();w.document.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte de cartera</title>${css?`<link rel="stylesheet" href="${css.href}">`:""}<style>body{margin:0;background:#fff;color:#252334}.print-report-sheet{display:block!important;max-width:none!important;box-shadow:none!important}.print-table-scroll{overflow:visible!important} @page{size:A4 landscape;margin:10mm}</style></head><body>${html}</body></html>`);w.document.close();w.focus();setTimeout(()=>{w.print();setTimeout(()=>w.close(),700);},500);}catch(e){console.error(e);showToast("No fue posible abrir la impresión.",true);}}
  async function downloadPDF(builder=buildReportHTML,filePrefix="reporte-cartera"){const area=id("print-report");if(!area){showToast("No se encontró el área de reporte.",true);return;}if(!window.html2canvas||!window.jspdf?.jsPDF){showToast("No se cargaron los componentes necesarios para PDF. Verifica tu conexión a internet y recarga la página.",true);return;}area.innerHTML=builder();area.classList.add("pdf-rendering");try{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const images=[...area.querySelectorAll("img")];await Promise.all(images.map(img=>img.complete?Promise.resolve():new Promise(r=>{img.onload=img.onerror=r;})));const canvas=await html2canvas(area,{scale:2,useCORS:true,allowTaint:false,backgroundColor:"#ffffff",logging:false});const {jsPDF}=window.jspdf;const pdf=new jsPDF({orientation:"landscape",unit:"mm",format:"a4"});const pageW=297,pageH=210,margin=8,imgW=pageW-margin*2,pxPerPage=canvas.width*(pageH-margin*2)/imgW;let sourceY=0;while(sourceY<canvas.height){const h=Math.min(pxPerPage,canvas.height-sourceY);const pageCanvas=document.createElement("canvas");pageCanvas.width=canvas.width;pageCanvas.height=h;pageCanvas.getContext("2d").drawImage(canvas,0,sourceY,canvas.width,h,0,0,canvas.width,h);if(sourceY>0)pdf.addPage();pdf.addImage(pageCanvas.toDataURL("image/jpeg",0.95),"JPEG",margin,margin,imgW,h*imgW/canvas.width);sourceY+=h;}pdf.save(`${filePrefix}-${new Date().toISOString().slice(0,10)}.pdf`);showToast("PDF descargado correctamente.");}catch(e){console.error(e);showToast("No fue posible generar el PDF. Abre la consola del navegador para ver el detalle.",true);}finally{area.classList.remove("pdf-rendering");}}

  function buildAdvisorSummaryReportHTML(){
    const filtered=getFilteredAdminCalls(), groups={};
    filtered.forEach(c=>{const a=c.perfilescr||{},name=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Sin asesor";const key=c.asesor_id||name;if(!groups[key])groups[key]={nombre:name,total:0,contestadas:0,nocontestadas:0,whatsapp:0,compromisos:0,pagos:0,zones:new Set()};const g=groups[key];g.total++;if(c.llamada==="Contestada")g.contestadas++;if(c.llamada==="No contestada")g.nocontestadas++;if(c.whatsapp_enviado)g.whatsapp++;if(c.compromiso_pago)g.compromisos++;if(c.pago)g.pagos++;if(c.zona)g.zones.add(c.zona);});
    const rows=Object.values(groups).map(g=>`<tr><td><strong>${escapeHTML(g.nombre)}</strong></td><td>${g.total}</td><td>${g.contestadas}</td><td>${g.nocontestadas}</td><td>${g.whatsapp}</td><td>${g.compromisos}</td><td>${g.pagos}</td><td>${escapeHTML([...g.zones].join(", ")||"—")}</td></tr>`).join("");
    const total=filtered.length;
    const comparativo=Object.values(groups).sort((a,b)=>b.total-a.total).slice(0,8).map(g=>({label:g.nombre,value:g.total,color:"#8064b3"}));
    return `<div class="print-report-sheet compact-pdf">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">RESUMEN DE LLAMADAS</span><h1>Comparativo por asesor</h1><p>Periodo: <strong>${escapeHTML(value("filtroDesdeAdmin")||value("filtroHastaAdmin")?`${value("filtroDesdeAdmin")?formatDate(value("filtroDesdeAdmin")):"Inicio"} – ${value("filtroHastaAdmin")?formatDate(value("filtroHastaAdmin")):"Actual"}`:"Todos los periodos")}</strong> · Asesores: <strong>${escapeHTML(asesoresComparadosTexto())}</strong></p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Total llamadas</span><strong>${total}</strong></div><div class="print-summary-card"><span>Asesores comparados</span><strong>${Object.keys(groups).length}</strong></div><div class="print-summary-card"><span>Contestadas</span><strong>${filtered.filter(c=>c.llamada==="Contestada").length}</strong></div><div class="print-summary-card"><span>No contestadas</span><strong>${filtered.filter(c=>c.llamada==="No contestada").length}</strong></div></div><section class="print-charts" style="grid-template-columns:1fr"><div class="print-chart-card"><h2>Llamadas totales por asesor</h2>${svgBarCompare(comparativo,900)}</div></section><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">DETALLE AGRUPADO</span><h2>Resumen de llamadas por asesor</h2></div><strong>${Object.keys(groups).length} asesor${Object.keys(groups).length===1?"":"es"}</strong></div><div class="print-table-scroll"><table><thead><tr><th>Asesor</th><th>Total</th><th>Contestadas</th><th>No contestadas</th><th>WhatsApp</th><th>Compromisos</th><th>Pagos</th><th>Zonas gestionadas</th></tr></thead><tbody>${rows||'<tr><td colspan="8" class="print-empty-row">No hay llamadas para los filtros seleccionados.</td></tr>'}</tbody></table></div></section></div>`;
  }
  function downloadAdvisorSummaryExcel(){
    (async () => {
    try{
      if(!window.XLSX){showToast("No se pudo cargar el módulo de Excel.",true);return;}
      const filtered=getFilteredAdminCalls(),groups={};
      filtered.forEach(c=>{const a=c.perfilescr||{},name=[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Sin asesor";const key=c.asesor_id||name;if(!groups[key])groups[key]={Asesor:name,Total:0,Contestadas:0,"No contestadas":0,WhatsApp:0,Compromisos:0,Pagos:0,Zonas:new Set()};const g=groups[key];g.Total++;if(c.llamada==="Contestada")g.Contestadas++;if(c.llamada==="No contestada")g["No contestadas"]++;if(c.whatsapp_enviado)g.WhatsApp++;if(c.compromiso_pago)g.Compromisos++;if(c.pago)g.Pagos++;if(c.zona)g.Zonas.add(c.zona);});
      const grouped=Object.values(groups).map(g=>({...g,Zonas:[...g.Zonas].join(", ")||"—"}));
      const wb=window.XLSX.utils.book_new();
      const wsResumen=window.XLSX.utils.json_to_sheet(grouped.length?grouped:[{Asesor:"",Total:0,Contestadas:0,"No contestadas":0,WhatsApp:0,Compromisos:0,Pagos:0,Zonas:""}]);
      wsResumen["!cols"]=[{wch:28},{wch:10},{wch:14},{wch:17},{wch:12},{wch:14},{wch:10},{wch:35}];
      window.XLSX.utils.book_append_sheet(wb,wsResumen,"Resumen por asesor");
      const wsGraficos=window.XLSX.utils.aoa_to_sheet([["Gráficos comparativos por asesor"]]); wsGraficos["!cols"]=[{wch:14}];
      window.XLSX.utils.book_append_sheet(wb,wsGraficos,"Gráficos");
      const detail=filtered.map(c=>{const a=c.perfilescr||{};return {"Asesor":[a.nombre,a.apellido].filter(Boolean).join(" ")||"—","Cliente":c.cliente,"Llamada":c.llamada,"Tipo de llamada":c.tipo_gestion||"—","Zona":c.zona||"—","WhatsApp":c.whatsapp_enviado?"Sí":"No","Compromiso":c.compromiso_pago?formatDate(c.fecha_compromiso):"—","Pago":c.pago?"Sí":"No","Fecha":c.fecha_llamada};});
      const wsDetalle=window.XLSX.utils.json_to_sheet(detail.length?detail:[{"Asesor":"","Cliente":"","Llamada":"","Tipo de llamada":"","Zona":"","WhatsApp":"","Compromiso":"","Pago":"","Fecha":""}]);
      wsDetalle["!cols"]=[{wch:25},{wch:22},{wch:16},{wch:42},{wch:16},{wch:10},{wch:14},{wch:8},{wch:14}];
      window.XLSX.utils.book_append_sheet(wb,wsDetalle,"Detalle");
      const asesorCat=grouped.map(g=>g.Asesor), totalVals=grouped.map(g=>g.Total), contestadasVals=grouped.map(g=>g.Contestadas), pagosVals=grouped.map(g=>g.Pagos);
      const filas=grouped.length, base=2; // fila 1 = encabezado en "Resumen por asesor"
      const charts=grouped.length?[{
        type:"bar", title:"Total de llamadas por asesor", sheetRef:"'Resumen por asesor'",
        catCount:filas, cats:asesorCat, series:[
          {name:"Total", valRange:`$B$${base}:$B$${base+filas-1}`, vals:totalVals, color:"8064b3"},
          {name:"Contestadas", valRange:`$C$${base}:$C$${base+filas-1}`, vals:contestadasVals, color:"2ecc71"}
        ], catRange:`$A$${base}:$A$${base+filas-1}`,
        anchor:{fromCol:0,fromRow:2,toCol:8,toRow:22}
      },{
        type:"bar", title:"Pagos por asesor", sheetRef:"'Resumen por asesor'",
        catCount:filas, cats:asesorCat, series:[
          {name:"Pagos", valRange:`$G$${base}:$G$${base+filas-1}`, vals:pagosVals, color:"f1c40f"}
        ], catRange:`$A$${base}:$A$${base+filas-1}`,
        anchor:{fromCol:9,fromRow:2,toCol:16,toRow:22}
      }]:[];
      await saveWorkbookWithCharts(wb,2,charts,`resumen-llamadas-por-asesor-${new Date().toISOString().slice(0,10)}.xlsx`);
      showToast("Resumen por asesor descargado en Excel con gráficos.");
    }catch(e){console.error(e);showToast("No fue posible generar el Excel del resumen.",true);}
    })();
  }

  function buildAdvisorReportHTML(){
    const list=getFilteredAsesorCalls(),total=list.length,contestadas=list.filter(c=>c.llamada==="Contestada").length,no=list.filter(c=>c.llamada==="No contestada").length,equivocadas=list.filter(c=>c.llamada==="Equivocada").length,compromisos=list.filter(c=>c.compromiso_pago).length,pagos=list.filter(c=>c.pago).length,pct=n=>total?Math.round(n/total*100):0;
    const nombre=[currentProfile?.nombre,currentProfile?.apellido].filter(Boolean).join(" ")||currentProfile?.email||"Asesor";
    const meta=metaDe(currentProfile),avance=metaPct(calls.length,meta);
    const from=value("filtroAsesorDesde"),to=value("filtroAsesorHasta"),period=from||to?`${from?formatDate(from):"Inicio"} – ${to?formatDate(to):"Actual"}`:"Todos los periodos";
    const rows=list.map(c=>`<tr><td>${escapeHTML(c.cliente)}</td><td>${escapeHTML(c.llamada)}</td><td>${escapeHTML(TIPOS_GESTION_CORTO[c.tipo_gestion]||c.tipo_gestion||"—")}</td><td>${escapeHTML(c.zona)}</td><td>${formatDate(c.fecha_llamada)}</td><td>${c.compromiso_pago?formatDate(c.fecha_compromiso):"—"}</td><td>${c.pago?"Sí":"No"}</td></tr>`).join("");
    return `<div class="print-report-sheet">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">REPORTE DE AVANCE</span><h1>${escapeHTML(nombre)}</h1><p>Zona: <strong>${escapeHTML(currentProfile?.zona||"—")}</strong> · Periodo: <strong>${escapeHTML(period)}</strong></p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Llamadas del periodo</span><strong>${total}</strong></div><div class="print-summary-card"><span>Contestadas</span><strong>${contestadas}</strong></div><div class="print-summary-card"><span>Compromisos</span><strong>${compromisos}</strong></div><div class="print-summary-card"><span>Pagos</span><strong>${pagos}</strong></div><div class="print-summary-card"><span>Meta asignada</span><strong>${meta}</strong></div><div class="print-summary-card"><span>Avance de la meta</span><strong>${avance}%</strong></div><div class="print-summary-card"><span>Pendientes</span><strong>${Math.max(0,meta-calls.length)}</strong></div></div><section class="print-charts">${donutCardHTML("Tipo de llamada",[{label:"Contestada",value:contestadas,color:"#2ecc71"},{label:"No contestada",value:no,color:"#e74c3c"},{label:"Equivocada",value:equivocadas,color:"#f1c40f"},{label:"Sin especificar",value:sinEspecificar,color:"#9b8fb5"}],total,"total")}<div class="print-chart-card" style="grid-column:span 2"><h2>Tipo de llamada (gestión)</h2>${svgBarCompare(TIPOS_GESTION.map(t=>({label:TIPOS_GESTION_CORTO[t]||t,value:list.filter(c=>c.tipo_gestion===t).length,color:"#0ea5e9"})),620)}</div></section><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">DETALLE</span><h2>Mis llamadas</h2></div><strong>${total} resultado${total===1?"":"s"}</strong></div><div class="print-table-scroll"><table><thead><tr><th>Cliente</th><th>Llamada</th><th>Tipo de llamada</th><th>Zona</th><th>Fecha</th><th>Compromiso</th><th>Pago</th></tr></thead><tbody>${rows||'<tr><td colspan="7" class="print-empty-row">No hay registros.</td></tr>'}</tbody></table></div></section></div>`;
  }
  function previewAdvisorReport(){previewReport(buildAdvisorReportHTML);}
  function printAdvisorReport(){printReport(buildAdvisorReportHTML);}
  function downloadAdvisorPDF(){downloadPDF(buildAdvisorReportHTML,"mi-reporte-cartera");}

  // =================================================================
  // GRÁFICOS NATIVOS DE EXCEL (OOXML) — SheetJS solo escribe datos, así
  // que los gráficos reales se inyectan manipulando el .xlsx (que es un
  // zip) con JSZip: se agregan xl/charts/chartN.xml + xl/drawings/... y
  // se referencian desde la hoja de "Gráficos". Así el gráfico queda
  // embebido y editable en Excel, no como una imagen ni texto ASCII.
  // =================================================================
  function escapeXml(v){return String(v??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
  function chartXmlPie({title,sheetRef,catRange,valRange,catCount,cats,vals,colors}){
    const colorEls=colors.map((c,i)=>`<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${c}"/></a:solidFill></c:spPr></c:dPt>`).join("");
    const catPts=cats.map((v,i)=>`<c:pt idx="${i}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join("");
    const valPts=vals.map((v,i)=>`<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="es-CO" sz="1200" b="1"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>
<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/>
${colorEls}
<c:cat><c:strRef><c:f>${sheetRef}!${catRange}</c:f><c:strCache><c:ptCount val="${catCount}"/>${catPts}</c:strCache></c:strRef></c:cat>
<c:val><c:numRef><c:f>${sheetRef}!${valRange}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${catCount}"/>${valPts}</c:numCache></c:numRef></c:val>
</c:ser><c:firstSliceAng val="0"/></c:pieChart></c:plotArea>
<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
  }
  function chartXmlBar({title,sheetRef,catRange,catCount,cats,series}){
    const axId1=Math.floor(100000000+Math.random()*800000000), axId2=axId1+1;
    const sers=series.map((s,i)=>{
      const catPts=cats.map((v,j)=>`<c:pt idx="${j}"><c:v>${escapeXml(v)}</c:v></c:pt>`).join("");
      const valPts=s.vals.map((v,j)=>`<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join("");
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>
        <c:tx><c:v>${escapeXml(s.name)}</c:v></c:tx>
        <c:spPr><a:solidFill><a:srgbClr val="${s.color}"/></a:solidFill></c:spPr>
        <c:cat><c:strRef><c:f>${sheetRef}!${catRange}</c:f><c:strCache><c:ptCount val="${catCount}"/>${catPts}</c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:f>${sheetRef}!${s.valRange}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${catCount}"/>${valPts}</c:numCache></c:numRef></c:val>
      </c:ser>`;
    }).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="es-CO" sz="1200" b="1"/><a:t>${escapeXml(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>
<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>
<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>
${sers}
<c:axId val="${axId1}"/><c:axId val="${axId2}"/>
</c:barChart>
<c:catAx><c:axId val="${axId1}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:txPr><a:bodyPr rot="-2700000" vert="horz"/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="es-CO"/></a:p></c:txPr><c:crossAx val="${axId2}"/></c:catAx>
<c:valAx><c:axId val="${axId2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:crossAx val="${axId1}"/></c:valAx>
</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/></c:chart></c:chartSpace>`;
  }
  function drawingXmlAnchors(anchors){
    const frames=anchors.map(a=>`
<xdr:twoCellAnchor>
<xdr:from><xdr:col>${a.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>${a.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${a.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro="">
<xdr:nvGraphicFramePr><xdr:cNvPr id="${a.id}" name="${a.name}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>
<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${a.chartRid}"/></a:graphicData></a:graphic>
</xdr:graphicFrame>
<xdr:clientData/>
</xdr:twoCellAnchor>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${frames}
</xdr:wsDr>`;
  }
  async function injectChartsIntoWorkbook(buf,sheetIndex,charts){
    const zip=await window.JSZip.loadAsync(buf);
    const sheetPath=`xl/worksheets/sheet${sheetIndex}.xml`;
    let sheetXml=await zip.file(sheetPath).async("string");
    const anchors=[];
    charts.forEach((c,i)=>{
      const n=i+1;
      const xml=c.type==="pie"?chartXmlPie(c):chartXmlBar(c);
      zip.file(`xl/charts/chart${n}.xml`,xml);
      anchors.push({chartRid:`rId${n}`,fromCol:c.anchor.fromCol,fromRow:c.anchor.fromRow,toCol:c.anchor.toCol,toRow:c.anchor.toRow,id:100+n,name:`Chart${n}`});
    });
    zip.file("xl/drawings/drawing1.xml",drawingXmlAnchors(anchors));
    zip.file("xl/drawings/_rels/drawing1.xml.rels",`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((c,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${i+1}.xml"/>`).join("")}</Relationships>`);
    zip.file(`xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`,`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
    if(!sheetXml.includes("<drawing ")) sheetXml=sheetXml.replace("</worksheet>",`<drawing r:id="rIdDrawing1"/></worksheet>`);
    zip.file(sheetPath,sheetXml);
    let ct=await zip.file("[Content_Types].xml").async("string");
    let additions=`<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
    charts.forEach((c,i)=>{additions+=`<Override PartName="/xl/charts/chart${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`;});
    ct=ct.replace("</Types>",`${additions}</Types>`);
    zip.file("[Content_Types].xml",ct);
    return zip.generateAsync({type:"uint8array"});
  }
  async function saveWorkbookWithCharts(wb,sheetIndexForCharts,charts,filename){
    const buf=window.XLSX.write(wb,{type:"array",bookType:"xlsx"});
    let finalBuf=buf;
    if(window.JSZip&&charts&&charts.length){
      try{ finalBuf=await injectChartsIntoWorkbook(buf,sheetIndexForCharts,charts); }
      catch(e){ console.error("No se pudieron insertar los gráficos nativos, se descarga el Excel sin gráficos:",e); finalBuf=buf; }
    }
    try{
      const blob=new Blob([finalBuf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);
      setTimeout(()=>URL.revokeObjectURL(url),4000);
    }catch(e){
      console.error("No fue posible iniciar la descarga, se usa el método alternativo:",e);
      window.XLSX.writeFile(wb,filename);
    }
  }

  function downloadExcel(){
    (async () => {
    try{
      if(!window.XLSX){showToast("No se pudo cargar el módulo de Excel.",true);return;}
      const filtered=getFilteredAdminCalls();
      const total=filtered.length,contestadas=filtered.filter(c=>c.llamada==="Contestada").length,no=filtered.filter(c=>c.llamada==="No contestada").length,equivocadas=filtered.filter(c=>c.llamada==="Equivocada").length,sinEspecificar=filtered.filter(c=>!c.llamada||c.llamada==="Sin especificar").length,compromisos=filtered.filter(c=>c.compromiso_pago).length,pagos=filtered.filter(c=>c.pago).length,pct=n=>total?Math.round(n/total*100):0;
      const metas=metasResumen(filtered),metaTotal=metas.reduce((a,f)=>a+f.meta,0);
      const period=value("filtroDesdeAdmin")||value("filtroHastaAdmin")?`${value("filtroDesdeAdmin")?formatDate(value("filtroDesdeAdmin")):"Inicio"} – ${value("filtroHastaAdmin")?formatDate(value("filtroHastaAdmin")):"Actual"}`:"Todos los periodos";

      const summary=[];
      summary.push(["REPORTE DE CARTERA"]); summary.push(["Periodo",period]); summary.push(["Asesores",asesoresComparadosTexto()]); summary.push([]);
      summary.push(["RESUMEN GENERAL"]); summary.push(["Indicador","Cantidad","Porcentaje"]);
      summary.push(["Total llamadas",total,"100%"]); summary.push(["Contestadas",contestadas,`${pct(contestadas)}%`]); summary.push(["No contestadas",no,`${pct(no)}%`]); summary.push(["Equivocadas",equivocadas,`${pct(equivocadas)}%`]); summary.push(["Sin especificar",sinEspecificar,`${pct(sinEspecificar)}%`]); summary.push(["Compromisos de pago",compromisos,`${pct(compromisos)}%`]); summary.push(["Pagos",pagos,`${pct(pagos)}%`]); summary.push(["Meta total de llamadas",metaTotal,`${metaPct(total,metaTotal)}% cumplido`]); summary.push([]);
      summary.push(["TIPO DE LLAMADA","Cantidad"]);
      const tipoStart=summary.length+1;
      summary.push(["Contestada",contestadas]); summary.push(["No contestada",no]); summary.push(["Equivocada",equivocadas]); summary.push(["Sin especificar",sinEspecificar]);
      const tipoEnd=summary.length; summary.push([]);
      summary.push(["TIPO DE LLAMADA (GESTIÓN)","Cantidad"]);
      const gestionStart=summary.length+1;
      TIPOS_GESTION.forEach(t=>summary.push([t,filtered.filter(c=>c.tipo_gestion===t).length]));
      const gestionEnd=summary.length; summary.push([]);
      summary.push(["CUMPLIMIENTO DE METAS POR ASESOR"]); summary.push(["Asesor","Meta","Llamadas realizadas","Pendientes","% de cumplimiento"]);
      const metasStart=summary.length+1;
      metas.forEach(f=>summary.push([f.nombre,f.meta,f.hechas,f.pendientes,`${f.pct}%`]));
      const metasEnd=summary.length;

      const wsResumen=window.XLSX.utils.aoa_to_sheet(summary); wsResumen["!cols"]=[{wch:42},{wch:16},{wch:20},{wch:15},{wch:20}];
      const wb=window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb,wsResumen,"Resumen");
      const wsGraficos=window.XLSX.utils.aoa_to_sheet([["Gráficos del reporte"]]); wsGraficos["!cols"]=[{wch:14}];
      window.XLSX.utils.book_append_sheet(wb,wsGraficos,"Gráficos");
      const detail=filtered.map(c=>{const a=c.perfilescr||{};return {"Asesor":[a.nombre,a.apellido].filter(Boolean).join(" ")||"—","Cliente":c.cliente,"Llamada":c.llamada,"Tipo de llamada":c.tipo_gestion||"—","Zona":c.zona||"—","WhatsApp":c.whatsapp_enviado?"Sí":"No","Compromiso":c.compromiso_pago?formatDate(c.fecha_compromiso):"—","Pago":c.pago?"Sí":"No","Fecha":c.fecha_llamada};});
      const wsDetalle=window.XLSX.utils.json_to_sheet(detail.length?detail:[{"Asesor":"","Cliente":"","Llamada":"","Tipo de llamada":"","Zona":"","WhatsApp":"","Compromiso":"","Pago":"","Fecha":""}]);
      wsDetalle["!cols"]=[{wch:25},{wch:22},{wch:16},{wch:42},{wch:16},{wch:10},{wch:14},{wch:8},{wch:14}];
      window.XLSX.utils.book_append_sheet(wb,wsDetalle,"Detalle");

      const charts=[{
        type:"pie", title:"Tipo de llamada", sheetRef:"Resumen",
        catRange:`$A$${tipoStart}:$A$${tipoEnd}`, valRange:`$B$${tipoStart}:$B$${tipoEnd}`, catCount:tipoEnd-tipoStart+1,
        cats:["Contestada","No contestada","Equivocada","Sin especificar"], vals:[contestadas,no,equivocadas,sinEspecificar], colors:["2ecc71","e74c3c","f1c40f","9b8fb5"],
        anchor:{fromCol:0,fromRow:1,toCol:7,toRow:20}
      },{
        type:"bar", title:"Tipo de llamada (gestión)", sheetRef:"Resumen",
        catRange:`$A$${gestionStart}:$A$${gestionEnd}`, catCount:gestionEnd-gestionStart+1, cats:TIPOS_GESTION.map(t=>TIPOS_GESTION_CORTO[t]||t),
        series:[{name:"Cantidad", valRange:`$B$${gestionStart}:$B$${gestionEnd}`, vals:TIPOS_GESTION.map(t=>filtered.filter(c=>c.tipo_gestion===t).length), color:"0ea5e9"}],
        anchor:{fromCol:8,fromRow:1,toCol:19,toRow:20}
      }];
      if(metas.length){
        charts.push({
          type:"bar", title:"Cumplimiento de metas por asesor", sheetRef:"Resumen",
          catRange:`$A$${metasStart}:$A$${metasEnd}`, catCount:metasEnd-metasStart+1, cats:metas.map(f=>f.nombre),
          series:[
            {name:"Meta", valRange:`$B$${metasStart}:$B$${metasEnd}`, vals:metas.map(f=>f.meta), color:"d7cdef"},
            {name:"Realizadas", valRange:`$C$${metasStart}:$C$${metasEnd}`, vals:metas.map(f=>f.hechas), color:"8064b3"}
          ],
          anchor:{fromCol:0,fromRow:22,toCol:9,toRow:41}
        });
      }
      await saveWorkbookWithCharts(wb,2,charts,`reporte-cartera-${new Date().toISOString().slice(0,10)}.xlsx`);
      showToast("Excel descargado con gráficos nativos y detalle de llamadas.");
    }catch(e){console.error(e);showToast("No fue posible generar el Excel.",true);}
    })();
  }

  function populateSurveyFilters(){
    const select=id("filtroEncuestaAsesor"); if(!select)return;
    const current=select.value;
    const people=[...advisors];
    if(isCurrentAdmin() && !people.some(p=>p.id===currentProfile.id)) people.push(currentProfile);
    surveys.forEach(s=>{const p=s.perfilescr;if(p&&!people.some(x=>x.id===p.id))people.push(p);});
    select.innerHTML='<option value="">Todos los responsables</option>'+people.map(a=>`<option value="${a.id}">${escapeHTML([a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Usuario")}${a.rol==="administrador"?" · Administrador":""}</option>`).join("");
    select.value=current;
  }
  function getFilteredSurveys(){
    const asesor=value("filtroEncuestaAsesor"),from=value("filtroEncuestaDesde"),to=value("filtroEncuestaHasta"),text=value("filtroEncuestaTexto").toLowerCase();
    return surveys.filter(s=>{
      const a=s.perfilescr||{};
      const search=[a.nombre,a.apellido,a.email,s.codigo_usuario,s.calificacion_servicio,s.calificacion_tecnica,s.calificacion_administrativa,s.agilidad_averias,s.recomendaria,s.recomendacion_felicitacion,s.observacion_servicio,s.observacion_tecnica,s.observacion_administrativa].join(" ").toLowerCase();
      const fecha=surveyDate(s);
      return (!asesor||s.asesor_id===asesor)&&(!from||fecha>=from)&&(!to||fecha<=to)&&(!text||search.includes(text));
    });
  }
  function surveyAdvisorName(s){
    const a=s?.perfilescr||{};
    if(a.nombre||a.apellido) return [a.nombre,a.apellido].filter(Boolean).join(" ");
    if(s?.asesor_id===currentProfile?.id) return [currentProfile?.nombre,currentProfile?.apellido].filter(Boolean).join(" ")||currentProfile?.email||"—";
    const adv=advisors.find(x=>x.id===s?.asesor_id);
    return adv?[adv.nombre,adv.apellido].filter(Boolean).join(" ")||adv.email||"—": "—";
  }
  function renderSurveys(){
    const tbody=id("tabla-encuestas"); if(!tbody)return;
    const filtered=getFilteredSurveys();
    setText("survey-result-count",`${filtered.length} encuesta${filtered.length===1?"":"s"}`);
    tbody.innerHTML=filtered.length?filtered.map(s=>{
      return `<tr><td>${formatDate(surveyDate(s))}</td><td><strong>${escapeHTML(surveyAdvisorName(s))}</strong></td><td>${escapeHTML(s.codigo_usuario||"—")}</td><td>${escapeHTML(s.calificacion_servicio||"—")}</td><td>${escapeHTML(s.calificacion_tecnica||"—")}</td><td>${escapeHTML(s.calificacion_administrativa||"—")}</td><td>${escapeHTML(s.agilidad_averias||"—")}</td><td>${escapeHTML(s.recomendaria||"—")}</td><td>${escapeHTML(s.recomendacion_felicitacion||"—")}</td><td>${escapeHTML(s.observacion_servicio||"—")}</td><td>${escapeHTML(s.observacion_tecnica||"—")}</td><td>${escapeHTML(s.observacion_administrativa||"—")}</td></tr>`;
    }).join(""):`<tr class="empty-row"><td colspan="12">${surveys.length?"No se encontraron encuestas con los filtros seleccionados.":"No hay encuestas registradas."}</td></tr>`;
  }
  function clearSurveyFilters(){
    ["filtroEncuestaAsesor","filtroEncuestaDesde","filtroEncuestaHasta","filtroEncuestaTexto"].forEach(x=>{if(id(x))id(x).value="";});
    renderSurveys();
  }
  function surveyPeriod(){
    const from=value("filtroEncuestaDesde"),to=value("filtroEncuestaHasta");
    return from||to?`${from?formatDate(from):"Inicio"} – ${to?formatDate(to):"Actual"}`:"Todos los periodos";
  }
  function surveyAdvisorFilterName(){
    const uid=value("filtroEncuestaAsesor");
    if(!uid)return "Todos los asesores";
    if(uid===currentProfile?.id)return [currentProfile.nombre,currentProfile.apellido].filter(Boolean).join(" ")||currentProfile.email||"Asesor";
    const a=advisors.find(x=>x.id===uid);
    return a?[a.nombre,a.apellido].filter(Boolean).join(" ")||a.email||"Asesor":"Asesor";
  }
  function buildSurveyReportHTML(){
    const filtered=getFilteredSurveys();
    const rows=filtered.map(s=>`<tr><td>${formatDate(surveyDate(s))}</td><td>${escapeHTML(surveyAdvisorName(s))}</td><td>${escapeHTML(s.codigo_usuario||"—")}</td><td>${escapeHTML(s.calificacion_servicio||"—")}</td><td>${escapeHTML(s.calificacion_tecnica||"—")}</td><td>${escapeHTML(s.calificacion_administrativa||"—")}</td><td>${escapeHTML(s.agilidad_averias||"—")}</td><td>${escapeHTML(s.recomendaria||"—")}</td><td>${escapeHTML(s.recomendacion_felicitacion||"—")}</td><td>${escapeHTML(s.observacion_servicio||"—")}</td><td>${escapeHTML(s.observacion_tecnica||"—")}</td><td>${escapeHTML(s.observacion_administrativa||"—")}</td></tr>`).join("");
    return `<div class="print-report-sheet survey-print-sheet">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">REPORTE DE SATISFACCIÓN</span><h1>Encuestas independientes</h1><p>Asesor: <strong>${escapeHTML(surveyAdvisorFilterName())}</strong> · Periodo: <strong>${escapeHTML(surveyPeriod())}</strong></p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Total encuestas</span><strong>${filtered.length}</strong></div><div class="print-summary-card"><span>Recomendarían</span><strong>${filtered.filter(s=>s.recomendaria==="SI").length}</strong></div><div class="print-summary-card"><span>No recomendarían</span><strong>${filtered.filter(s=>s.recomendaria==="NO").length}</strong></div></div><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">RESPUESTAS</span><h2>Detalle de encuestas</h2></div><strong>${filtered.length} encuesta${filtered.length===1?"":"s"}</strong></div><div class="print-table-scroll"><table class="survey-report-table"><thead><tr><th>Fecha</th><th>Asesor</th><th>Usuario encuestado</th><th>Servicio</th><th>Técnica</th><th>Administrativa</th><th>Averías</th><th>Recomendaría</th><th>Recomendación / felicitación</th><th>Obs. servicio</th><th>Obs. técnica</th><th>Obs. administrativa</th></tr></thead><tbody>${rows||'<tr><td colspan="12" class="print-empty-row">No hay encuestas para los filtros seleccionados.</td></tr>'}</tbody></table></div></section></div>`;
  }
  function downloadSurveyExcel(){
    try{
      if(!window.XLSX){showToast("No se pudo cargar el módulo de Excel.",true);return;}
      const filtered=getFilteredSurveys();
      const detail=filtered.map(s=>{
        return {
          "Fecha":surveyDate(s),"Asesor":surveyAdvisorName(s),
          "01. Usuario encuestado":s.codigo_usuario||"","02. Servicio":s.calificacion_servicio||"",
          "03. Técnica":s.calificacion_tecnica||"","04. Administrativa":s.calificacion_administrativa||"",
          "05. Averías":s.agilidad_averias||"","06. Recomendaría":s.recomendaria||"",
          "07. Recomendación / felicitación":s.recomendacion_felicitacion||"",
          "Observación servicio":s.observacion_servicio||"","Observación técnica":s.observacion_tecnica||"",
          "Observación administrativa":s.observacion_administrativa||""
        };
      });
      const ws=window.XLSX.utils.json_to_sheet(detail.length?detail:[{"Fecha":"","Asesor":""}]);
      ws["!cols"]=[{wch:14},{wch:24},{wch:28},{wch:18},{wch:18},{wch:20},{wch:22},{wch:16},{wch:40},{wch:35},{wch:35},{wch:35}];
      const wb=window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb,ws,"Encuestas");
      const summary=window.XLSX.utils.aoa_to_sheet([["REPORTE DE ENCUESTAS"],["Asesor",surveyAdvisorFilterName()],["Periodo",surveyPeriod()],["Total encuestas",filtered.length],["Recomendarían",filtered.filter(s=>s.recomendaria==="SI").length],["No recomendarían",filtered.filter(s=>s.recomendaria==="NO").length]]);
      window.XLSX.utils.book_append_sheet(wb,summary,"Resumen");
      window.XLSX.writeFile(wb,`reporte-encuestas-cartera-${new Date().toISOString().slice(0,10)}.xlsx`);
      showToast("Reporte de encuestas descargado.");
    }catch(e){console.error(e);showToast("No fue posible generar el Excel de encuestas.",true);}
  }

  const ALL_VIEWS=["auth-view","register-view","vista-asesor","admin-dashboard","vista-admin","vista-encuestas-hub","vista-encuestas","vista-encuesta-seguimiento","vista-encuesta-servicio","vista-usuarios","vista-configuracion","vista-respaldo"];
  function showAuthView(){ALL_VIEWS.forEach(x=>id(x).classList.add("hidden"));id("auth-view").classList.remove("hidden");id("session-area").classList.add("hidden");id("btn-menu").classList.add("hidden");id("sidebar").classList.add("hidden");}
  function showView(viewId){ALL_VIEWS.forEach(x=>id(x).classList.add("hidden"));id(viewId).classList.remove("hidden");if(viewId!=="auth-view"&&currentProfile){id("session-area").classList.remove("hidden");id("btn-menu").classList.remove("hidden");id("sidebar").classList.remove("hidden");}}
  function setSectionMode(viewId,mode){const view=id(viewId);if(!view)return;const panels=view.querySelectorAll(":scope > .survey-panel");if(!panels.length)return;panels.forEach(p=>p.classList.toggle("hidden",p.dataset.panel!==mode));}
  async function logout(){
    try {
      const {error}=await sbClient.auth.signOut();
      if(error){showToast("No fue posible cerrar la sesión.",true);return;}
      currentUser=null; currentProfile=null; calls=[]; advisors=[]; surveys=[]; seguimientoSurveys=[]; servicioSurveys=[];
      asesoresSeleccionados=[];
      closeSidebar(); showAuthView();
      const form=id("login-form"); if(form)form.reset();
      showToast("Sesión cerrada correctamente.");
    } catch(error) {
      console.error("LOGOUT ERROR:",error);
      showToast("No fue posible cerrar la sesión.",true);
    }
  }
  function llamadaBadge(t){if(t==="Contestada")return '<span class="badge badge-complete">Contestada</span>';if(t==="No contestada")return '<span class="badge badge-pending">No contestada</span>';if(t==="Equivocada")return '<span class="badge badge-cancelled">Equivocada</span>';return '<span class="badge badge-disabled">Sin especificar</span>';}
  const TIPOS_GESTION_CORTO={"Gestión reporte a Data Crédito y abogados":"Reporte DataCrédito/abogados","Gestión lista de suspensión":"Lista de suspensión","Gestión recuperación de equipo":"Recuperación de equipo","Gestión ofreciendo servicio de la empresa":"Ofrecimiento de servicio","Gestión actualización de información":"Actualización de información"};
  function tipoGestionBadge(t){if(!t)return '<span class="badge badge-disabled">—</span>';return `<span class="badge badge-pending" title="${escapeHTML(t)}">${escapeHTML(TIPOS_GESTION_CORTO[t]||t)}</span>`;}
  function whatsappBadge(c){return c.whatsapp_enviado?'<span class="badge badge-active">Enviado</span>':'<span class="badge badge-disabled">No</span>';}
  function pagoBadge(v){return v?'<span class="badge badge-active">Sí</span>':'<span class="badge badge-disabled">No</span>';}
  function compromisoCell(c){return c.compromiso_pago?`<span class="badge badge-pending">${formatDate(c.fecha_compromiso)}</span>`:'<span class="badge badge-disabled">—</span>';}
  function formatDate(d){if(!d)return "—";const p=d.split("-");return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:escapeHTML(d);}
  function setTodayDefault(){const x=id("fechaLlamada");if(x&&!x.value)x.value=getTodayISO();}function getTodayISO(){const n=new Date(),o=n.getTimezoneOffset(),l=new Date(n.getTime()-o*60000);return l.toISOString().slice(0,10);}
  function value(x){return id(x).value.trim();}function id(x){return document.getElementById(x);}function setText(x,v){if(id(x))id(x).textContent=v;}
  function escapeHTML(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
  async function downloadBackup(){
    const btn=id("btn-download-backup"),status=id("backup-status");
    if(!window.XLSX){showToast("No se pudo cargar el módulo de Excel.",true);return;}
    setButtonBusy(btn,true,"Generando respaldo...");
    try{
      const [callsRes,encRes,perfilesRes]=await Promise.all([
        sbClient.from("llamadascr").select("*").order("id",{ascending:true}),
        sbClient.from("encuestascr").select("*").order("id",{ascending:true}),
        sbClient.from("perfilescr").select("*").order("created_at",{ascending:true})
      ]);
      if(callsRes.error||encRes.error||perfilesRes.error){console.error(callsRes.error||encRes.error||perfilesRes.error);showToast("No fue posible generar el respaldo.",true);return;}
      const wb=window.XLSX.utils.book_new();
      const wsCalls=window.XLSX.utils.json_to_sheet(callsRes.data&&callsRes.data.length?callsRes.data:[{id:""}]);
      const wsEnc=window.XLSX.utils.json_to_sheet(encRes.data&&encRes.data.length?encRes.data:[{id:""}]);
      const wsPerfiles=window.XLSX.utils.json_to_sheet(perfilesRes.data&&perfilesRes.data.length?perfilesRes.data:[{id:""}]);
      window.XLSX.utils.book_append_sheet(wb,wsCalls,"Llamadas");
      window.XLSX.utils.book_append_sheet(wb,wsEnc,"Encuestas");
      window.XLSX.utils.book_append_sheet(wb,wsPerfiles,"Perfiles");
      const now=new Date();
      window.XLSX.writeFile(wb,`respaldo-cartera-${now.toISOString().slice(0,10)}.xlsx`);
      status.textContent=`Último respaldo generado: ${now.toLocaleString("es-CO")} · ${callsRes.data.length} llamadas, ${encRes.data.length} encuestas, ${perfilesRes.data.length} perfiles.`;
      showToast("Respaldo generado correctamente.");
    }catch(e){console.error(e);showToast("No fue posible generar el respaldo.",true);}
    finally{setButtonBusy(btn,false,"⭳ Descargar respaldo completo");}
  }

  function setButtonBusy(b,busy,text){if(!b)return;b.disabled=busy;b.textContent=text;}function authError(e){const m=(e?.message||"").toLowerCase();if(m.includes("invalid login credentials"))return "Correo o contraseña incorrectos.";if(m.includes("email not confirmed"))return "Debes confirmar tu correo antes de iniciar sesión.";if(m.includes("user already registered"))return "Ese correo ya está registrado.";return e?.message||"No fue posible completar la operación.";}
  function fileToDataURL(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file);});}
  let toastTimer;function showToast(msg,error=false){const t=id("toast");t.textContent=msg;t.classList.toggle("error",error);t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),3500);}


  function surveyDate(x){return (x.created_at||"").slice(0,10);}
  function getFilteredSeguimiento(){const f=value("seg-filter-from"),t=value("seg-filter-to"),u=value("seg-filter-user").toLowerCase(),a=value("seg-filter-att"),p=value("seg-filter-pay");return seguimientoSurveys.filter(x=>{const d=surveyDate(x);return(!f||d>=f)&&(!t||d<=t)&&(!u||String(x.usuario||"").toLowerCase().includes(u))&&(!a||x.atencion_asesor===a)&&(!p||x.fechas_pago===p);});}
  function getFilteredServicio(){const f=value("srv-filter-from"),t=value("srv-filter-to"),u=value("srv-filter-user").toLowerCase(),s=value("srv-filter-service"),r=value("srv-filter-retomar");return servicioSurveys.filter(x=>{const d=surveyDate(x);return(!f||d>=f)&&(!t||d<=t)&&(!u||String(x.usuario||"").toLowerCase().includes(u))&&(!s||x.servicio_retirado===s)&&(!r||x.interes_retomar===r);});}
  const _renderSeg=renderSeguimientoSurveys, _renderSrv=renderServicioSurveys;
  renderSeguimientoSurveys=function(){const rows=getFilteredSeguimiento();const t=id("tabla-seguimiento-encuesta");if(!t)return;t.innerHTML=rows.map(x=>`<tr><td>${formatDate(surveyDate(x))}</td><td>${escapeHTML(surveyAdvisorName(x))}</td><td>${escapeHTML(x.usuario)}</td><td>${escapeHTML(x.como_se_entero||"—")}</td><td>${escapeHTML(x.fechas_pago)}</td><td>${escapeHTML(x.medio_contrato)}</td><td>${escapeHTML(x.atencion_asesor)}</td><td>${escapeHTML(x.redes_sociales)}</td><td>${escapeHTML(x.cobro_tecnico)}</td><td>${escapeHTML(x.medios_pago)}</td></tr>`).join("")||'<tr class="empty-row"><td colspan="10">No hay encuestas con los filtros seleccionados.</td></tr>';}
  renderServicioSurveys=function(){const rows=getFilteredServicio();const t=id("tabla-servicio-encuesta");if(!t)return;t.innerHTML=rows.map(x=>`<tr><td>${formatDate(surveyDate(x))}</td><td>${escapeHTML(surveyAdvisorName(x))}</td><td>${escapeHTML(x.usuario)}</td><td>${escapeHTML(x.servicio_retirado)}</td><td>${escapeHTML(x.motivo_retiro||"—")}</td><td>${escapeHTML(x.interes_retomar)}</td><td>${escapeHTML(x.observaciones||"—")}</td></tr>`).join("")||'<tr class="empty-row"><td colspan="7">No hay encuestas con los filtros seleccionados.</td></tr>';}
  function clearSegFilters(){["seg-filter-from","seg-filter-to","seg-filter-user","seg-filter-att","seg-filter-pay"].forEach(k=>{if(id(k))id(k).value="";});renderSeguimientoSurveys();}
  function clearSrvFilters(){["srv-filter-from","srv-filter-to","srv-filter-user","srv-filter-service","srv-filter-retomar"].forEach(k=>{if(id(k))id(k).value="";});renderServicioSurveys();}

  function buildSeguimientoReportHTML(){
    const rows=getFilteredSeguimiento();
    const trs=rows.map(x=>`<tr><td>${formatDate(surveyDate(x))}</td><td>${escapeHTML(surveyAdvisorName(x))}</td><td>${escapeHTML(x.usuario)}</td><td>${escapeHTML(x.como_se_entero||"—")}</td><td>${escapeHTML(x.fechas_pago)}</td><td>${escapeHTML(x.medio_contrato)}</td><td>${escapeHTML(x.atencion_asesor)}</td><td>${escapeHTML(x.redes_sociales)}</td><td>${escapeHTML(x.cobro_tecnico)}</td><td>${escapeHTML(x.medios_pago)}</td><td>${formatDate(surveyDate(x))}</td></tr>`).join("");
    return `<div class="print-report-sheet">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">ENCUESTA DE SEGUIMIENTO</span><h1>Reporte de seguimiento</h1><p>${rows.length} registro${rows.length===1?"":"s"}</p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Total encuestas</span><strong>${rows.length}</strong></div><div class="print-summary-card"><span>Fechas de pago informadas</span><strong>${rows.filter(x=>x.fechas_pago==="SI").length}</strong></div><div class="print-summary-card"><span>Cobro técnico adicional</span><strong>${rows.filter(x=>x.cobro_tecnico==="SI").length}</strong></div></div><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">DETALLE</span><h2>Encuestas de seguimiento</h2></div></div><div class="print-table-scroll"><table><thead><tr><th>Fecha</th><th>Asesor</th><th>Usuario</th><th>¿Cómo se enteró?</th><th>Fechas de pago</th><th>Contrato</th><th>Atención</th><th>Redes</th><th>Cobro técnico</th><th>Medios de pago</th><th>Fecha</th></tr></thead><tbody>${trs||'<tr><td colspan="11" class="print-empty-row">No hay registros.</td></tr>'}</tbody></table></div></section></div>`;
  }
  function buildServicioReportHTML(){
    const rows=getFilteredServicio();
    const cards=rows.map((x,i)=>`<article class="survey-detail-card" style="border:1px solid #ddd7e7;border-radius:12px;padding:14px;margin:0 0 14px;background:#fff;break-inside:avoid;page-break-inside:avoid"><div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;margin-bottom:10px"><div><span class="print-kicker">ENCUESTA ${i+1}</span><h2 style="margin:3px 0 0">Detalle de encuesta de servicio</h2><p style="margin:4px 0 0;font-size:10px">Asesor: <strong>${escapeHTML(surveyAdvisorName(x))}</strong></p></div><strong>${formatDate(surveyDate(x))}</strong></div><table style="width:100%;border-collapse:collapse;font-size:10px"><tbody><tr><th style="width:28%;padding:7px;border:1px solid #ddd7e7;text-align:left">Usuario</th><td style="padding:7px;border:1px solid #ddd7e7">${escapeHTML(x.usuario||"—")}</td></tr><tr><th style="padding:7px;border:1px solid #ddd7e7;text-align:left">Servicio retirado</th><td style="padding:7px;border:1px solid #ddd7e7">${escapeHTML(x.servicio_retirado||"—")}</td></tr><tr><th style="padding:7px;border:1px solid #ddd7e7;text-align:left">Motivo del retiro</th><td style="padding:7px;border:1px solid #ddd7e7;white-space:pre-wrap">${escapeHTML(x.motivo_retiro||"—")}</td></tr><tr><th style="padding:7px;border:1px solid #ddd7e7;text-align:left">¿Le interesaría retomar?</th><td style="padding:7px;border:1px solid #ddd7e7">${escapeHTML(x.interes_retomar||"—")}</td></tr><tr><th style="padding:7px;border:1px solid #ddd7e7;text-align:left">Observaciones</th><td style="padding:7px;border:1px solid #ddd7e7;white-space:pre-wrap">${escapeHTML(x.observaciones||"—")}</td></tr></tbody></table></article>`).join("");
    return `<div class="print-report-sheet">${config.logo_url?`<div class="print-logo"><img src="${config.logo_url}" alt="Logo"></div>`:""}<div class="print-header"><div><span class="print-kicker">ENCUESTA DE SERVICIO</span><h1>Reporte de retiros de servicio</h1><p>Detalle completo de las encuestas registradas</p></div><div class="print-generated">Generado: ${new Date().toLocaleString("es-CO")}</div></div><div class="print-summary"><div class="print-summary-card"><span>Total encuestas</span><strong>${rows.length}</strong></div><div class="print-summary-card"><span>Interesados en retomar</span><strong>${rows.filter(x=>x.interes_retomar==="SI").length}</strong></div><div class="print-summary-card"><span>No interesados</span><strong>${rows.filter(x=>x.interes_retomar==="NO").length}</strong></div></div><section class="print-table-section"><div class="print-table-title"><div><span class="print-kicker">RESPUESTAS</span><h2>Detalle individual</h2></div><strong>${rows.length} encuesta${rows.length===1?"":"s"}</strong></div>${cards||'<div class="print-empty-row" style="padding:20px">No hay registros para los filtros seleccionados.</div>'}</section></div>`;
  }

  document.addEventListener("DOMContentLoaded",()=>{["seg-filter-from","seg-filter-to","seg-filter-user","seg-filter-att","seg-filter-pay"].forEach(k=>id(k)?.addEventListener("input",renderSeguimientoSurveys));id("seg-filter-clear")?.addEventListener("click",clearSegFilters);["srv-filter-from","srv-filter-to","srv-filter-user","srv-filter-service","srv-filter-retomar"].forEach(k=>id(k)?.addEventListener("input",renderServicioSurveys));id("srv-filter-clear")?.addEventListener("click",clearSrvFilters);
    id("btn-seg-excel")?.addEventListener("click",()=>downloadSimpleCSV("seguimiento",getFilteredSeguimiento()));
    id("btn-srv-excel")?.addEventListener("click",()=>downloadSimpleCSV("servicio",getFilteredServicio()));
    id("btn-seg-preview")?.addEventListener("click",()=>previewReport(buildSeguimientoReportHTML));
    id("btn-seg-pdf")?.addEventListener("click",()=>downloadPDF(buildSeguimientoReportHTML,"reporte-seguimiento-cartera"));
    id("btn-srv-preview")?.addEventListener("click",()=>previewReport(buildServicioReportHTML));
    id("btn-srv-pdf")?.addEventListener("click",()=>downloadPDF(buildServicioReportHTML,"reporte-servicio-cartera"));
  });

  window.setPago=setPago;window.deleteCall=deleteCall;window.editAdvisor=editAdvisor;window.toggleAdvisor=toggleAdvisor;window.deleteAdvisor=deleteAdvisor;
})();
