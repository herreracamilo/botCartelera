const express = require('express');
const puppeteer = require('puppeteer');
const he = require('he'); // sirve para decodificar entidades HTML
const app = express();
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const path = './data/avisos_enviados.json'; // Cambio de ruta para persistencia
const PORT = process.env.PORT || 4000;

// variables para cache
let cacheData = [];
let ultimaVez = null;

// Crear directorio data si no existe
if (!fs.existsSync('./data')) {
  fs.mkdirSync('./data', { recursive: true });
}

//obtengo y actualizo datos
async function updateData(){
  try {
    console.log('Actualizando datos de la cartelera...');
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=VizDisplayCompositor'
      ]
    });

  const page = await browser.newPage();

  await page.goto('https://gestiondocente.info.unlp.edu.ar/cartelera/data/0/10', {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  const result = await page.evaluate(() => {
    const preElement = document.querySelector('body > pre');
    if (!preElement) throw new Error('No se encontró el elemento con los datos');
    return JSON.parse(preElement.textContent);
  });
  await browser.close();
  cacheData = processJsonData(result);
  ultimaVez = new Date();
  console.log('Datos actualizados: ', ultimaVez.toLocaleString());

  } catch (error) {
    console.error('Error al actualizar los datos:', error);
  }
}

let pendientesDeEnvio = []; // almaceno por si ocurre un error al enviar
let avisosEnviados = new Set(); // el set no admite duplicados, por lo que es ideal para almacenar los avisos enviados

function cargarEnviados() {
  if (fs.existsSync(path)) {
    try {
      const datos = JSON.parse(fs.readFileSync(path, 'utf-8'));
      avisosEnviados = new Set(datos);
      console.log(`Cargados ${avisosEnviados.size} avisos enviados previamente`);
    } catch (error) {
      console.error('Error al cargar avisos enviados:', error);
      avisosEnviados = new Set();
    }
  }
}

function guardarEnviados() {
  try {
    fs.writeFileSync(path, JSON.stringify([...avisosEnviados]), 'utf-8');
  } catch (error) {
    console.error('Error al guardar avisos enviados:', error);
  }
}

function generarID(aviso) {
  return crypto.createHash('md5')
    .update(`${aviso.materia}-${aviso.titulo}-${aviso.fecha}`)
    .digest('hex');
}

function getNuevosAvisosDelDia(data) {
  //const hoy = new Date().toLocaleDateString('es-AR'); // manda a partir del dia de hoy
  const nuevos = data
    //.filter(m => m.fecha.startsWith(hoy))
    .filter(m => {
      const id = generarID(m);
      if (avisosEnviados.has(id)) return false;
      avisosEnviados.add(id);
      return true;
    });

  // ordenar por fecha y hora ascendente (más antiguo primero)
  nuevos.sort((a, b) => {
    const parseDate = str => {
      const [d, m, yAndTime] = str.split('/');
      const [y, time] = yAndTime.split(' ');
      return new Date(`${y}-${m}-${d}T${time || '00:00'}`);
    };
    return parseDate(a.fecha) - parseDate(b.fecha);
  });

  return nuevos;
}


async function enviarAlCanal(aviso, canalId) {
  try {
    const texto = `📌 *${aviso.materia}* - ${aviso.titulo}\n🗓️ ${aviso.fecha}\n🧑‍🏫 ${aviso.autor}\n📝 ${aviso.cuerpo}`;
    await axios.post('http://192.168.249.111:3000/api/sendText', {
      chatId: canalId,
      text: texto,
      session: 'default'
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });
    console.log(`Aviso enviado: ${aviso.titulo}`);
  } catch (error) {
    console.error('Error al enviar aviso al canal:', error.message);
    pendientesDeEnvio.push({ aviso, canalId, intentos: 1 }); //guardo los datos del aviso que no se pudo enviar
  }
}

async function revisarYEnviarNuevos(data, canalId) {
  const nuevos = getNuevosAvisosDelDia(data);
  console.log(`Encontrados ${nuevos.length} avisos nuevos`);

  for (const aviso of nuevos) {
    await enviarAlCanal(aviso, canalId);
    // Pequeña pausa entre envíos para no saturar
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  guardarEnviados();
}

// Middleware para logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});
//intervalo para reintentar envíos fallidos
setInterval(async () => {
  if (pendientesDeEnvio.length === 0) return;

  console.log(`Intentando reenviar ${pendientesDeEnvio.length} avisos pendientes...`);
  
  const pendientesRestantes = [];

  for (const item of pendientesDeEnvio) {
    try {
      await enviarAlCanal(item.aviso, item.canalId);
      // Si se envía correctamente, no se vuelve a agregar
    } catch (error) {
      // ===========por ahora saco el manejo de intentos múltiples===========
      // Si vuelve a fallar, lo agregamos nuevamente si no superó un límite de intentos
      /*item.intentos++;
      if (item.intentos <= 5) {
        pendientesRestantes.push(item);
      } else {
        console.warn(`Aviso descartado tras múltiples intentos: ${item.aviso.titulo}`);
      }
        */
    }
    await new Promise(resolve => setTimeout(resolve, 1000)); // espera entre intentos
  }
  pendientesDeEnvio = pendientesRestantes; // vuelvo a cargar los que dieron error de vuelta, aunque no deberia pasar
}, 60 * 1000); // reintentar cada 1 minuto

// inicializo sistema
cargarEnviados();

// Función para inicializar de forma segura
async function inicializar() {
  try {
    console.log('Iniciando aplicación...');
    await updateData();
    await revisarYEnviarNuevos(cacheData, '120363420856183423@newsletter');

    // Configurar intervalo de actualización
    setInterval(async () => {
      try {
        await updateData();
        await revisarYEnviarNuevos(cacheData, '120363420856183423@newsletter');
      } catch (error) {
        console.error('Error en actualización periódica:', error);
      }
    }, 5 * 60 * 1000);

    console.log('Sistema inicializado correctamente');
  } catch (error) {
    console.error('Error al inicializar:', error);
  }
}

// Inicializar después de 5 minutos de delay para asegurar que el servidor esté listo y se incie waha
setTimeout(inicializar, 300000);

app.get('/cartelera', async (req, res) => {
  try {
    const { materia, fecha } = req.query; // obtener parámetro de búsqueda

    let filteredData = [...cacheData]; // pongo los datos de caché en filteredData
    if (materia) {
      filteredData = filteredData.filter(m =>
        m.materia.toLowerCase().includes(materia.toLowerCase())
      );
    }

     if (fecha) {
      filteredData = filteredData.filter(m =>
        m.fecha.startsWith(fecha) // busca por fecha (formato DD/MM/AAAA)
      );
    }

    const cleanData = processJsonData({ mensajes: filteredData });
    res.json({
      total: cleanData.length,
      ultimaActualizacion: ultimaVez,
      datos: cleanData
    });


  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: error.message,
      details: 'Ocurrió un error al obtener los datos de la cartelera'
    });
  }
});

//forzar actualizacion de datos
app.get('/cartelera/update', async(req, res) => {
  try {
    await updateData();
    res.json({
      message: 'Datos actualizados manualmente',
      ultimaActualizacion: ultimaVez,
      totalAvisos: cacheData.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Error al actualizar datos',
      details: error.message
    });
  }
})

// Endpoint para estadísticas
app.get('/stats', (req, res) => {
  res.json({
    totalAvisos: cacheData.length,
    avisosEnviados: avisosEnviados.size,
    ultimaActualizacion: ultimaVez,
    uptime: process.uptime()
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    dataLoaded: cacheData.length > 0
  });
});

app.get('/', (req, res) => {
  res.json({
    message: 'Cartelera API activa!',
    version: '1.0.0',
    endpoints: [
      'GET /cartelera - Obtener avisos',
      'GET /cartelera/update - Forzar actualización',
      'GET /stats - Estadísticas',
      'GET /health - Estado de salud'
    ]
  });
});

// ### función para procesar los datos JSON
function processJsonData(data) {
  if (!data || !data.mensajes) return [];

  const he = require('he');

  return data.mensajes.map(m => {
    let raw = m.cuerpo || '';

    // decodificar entidades HTML
    raw = he.decode(raw);

    // convertir links <a href="url">texto</a> a "texto (url)" para no perder información de links en el cuerpo
    raw = raw.replace(/<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/gi, (match, url, text) => {
      return `${text} (${url})`;
    });

    // Reemplazar etiquetas que indican salto de línea por \n
    raw = raw
      .replace(/<\/?(h[1-6]|p|div|br|li|ul|ol)[^>]*>/gi, '\n') // saltos para tags block
      .replace(/<\/?strong[^>]*>/gi, '')  // quitar strong sin salto
      .replace(/<\/?em[^>]*>/gi, '')      // quitar em sin salto
      .replace(/<\/?span[^>]*>/gi, '')    // quitar span sin salto
      .replace(/<\/?u[^>]*>/gi, '')       // quitar u sin salto
      .replace(/<[^>]+>/g, '')            // quitar resto de tags

    // Reemplazar múltiples saltos de línea por máximo dos para mejor legibilidad
    raw = raw.replace(/\n\s*\n+/g, '\n\n');

    // Limpiar espacios al inicio y fin de cada línea y eliminar líneas vacías
    raw = raw
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    return {
      materia: m.materia,
      titulo: m.titulo || 'Sin título',
      fecha: m.fecha,
      cuerpo: raw,
      autor: m.autor?.trim() || 'No especificado'
    };
  })
  .filter(post => post.fecha)
  .sort((a, b) => {
    const parseDate = str => {
      const [d, m, yAndTime] = str.split('/');
      const [y, time] = yAndTime.split(' ');
      return new Date(`${y}-${m}-${d}T${time || '00:00'}`);
    };
    return parseDate(b.fecha) - parseDate(a.fecha);
  });
}

// Manejo graceful de cierre
process.on('SIGTERM', () => {
  console.log('Recibida señal SIGTERM, cerrando servidor...');
  guardarEnviados();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Recibida señal SIGINT, cerrando servidor...');
  guardarEnviados();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor API corriendo en http://0.0.0.0:${PORT}`);
});
