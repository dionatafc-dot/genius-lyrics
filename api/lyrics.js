import * as cheerio from 'cheerio';

// Fonte de letras: Letras.mus.br (sem token de API).
// Segredo compartilhado só entre esta função e o seu cenário do Make.
const MY_SECRET = process.env.MY_SECRET;

const BASE = 'https://www.letras.mus.br';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const NOTION_LIMIT = 1900; // margem sob o limite de 2000 chars por bloco do Notion

// --- Converte o nome do artista no slug de URL do Letras.mus.br ---
// "Samuel Batista Filho" -> "samuel-batista-filho"
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s-]/g, '') // remove caracteres especiais
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// --- Baixa o HTML de uma página (com User-Agent de navegador) ---
async function getPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' },
  });
  if (!res.ok) return null;
  return await res.text();
}

// --- Lista as músicas do artista a partir da página dele ---
// Seletor confirmado ao vivo: a.songList-table-songName
async function getArtistSongs(artistName) {
  const slug = slugify(artistName);
  const html = await getPage(`${BASE}/${slug}/`);
  const songs = [];
  if (!html) return { slug, songs };
  const $ = cheerio.load(html);
  const seen = new Set();
  $('a.songList-table-songName').each((_, el) => {
    const title = $(el).text().trim();
    let href = $(el).attr('href') || '';
    if (!href || !title) return;
    if (href.startsWith('/')) href = BASE + href;
    if (!seen.has(href)) {
      seen.add(href);
      songs.push({ title, url: href });
    }
  });
  return { slug, songs };
}

// --- Extrai a letra de uma página de música do Letras.mus.br ---
// Container confirmado: .lyric-original ; cada estrofe num <p>, quebras em <br>.
// Resiliente: qualquer falha devolve '' (nunca quebra o payload do Notion).
async function scrapeLyrics(url) {
  try {
    const html = await getPage(url);
    if (!html) return '';
    const $ = cheerio.load(html);
    // tenta os seletores mais prováveis, em ordem
    const cont =
      ($('.lyric-original').first().length && $('.lyric-original').first()) ||
      ($('.cnt-letra').first().length && $('.cnt-letra').first()) ||
      $('[class*="lyric"]').first();
    if (!cont || !cont.length) return '';
    const stanzas = [];
    cont.find('p').each((_, p) => {
      $(p).find('br').replaceWith('\n');
      const t = $(p).text().trim();
      if (t) stanzas.push(t);
    });
    if (stanzas.length) return stanzas.join('\n\n');
    // fallback: sem <p>, usa o texto do container inteiro
    cont.find('br').replaceWith('\n');
    return cont.text().trim();
  } catch {
    return '';
  }
}

// =====================================================================
//  Helpers do Notion — a função já devolve os blocos prontos e (opcional)
//  o corpo completo do POST /v1/pages.
// =====================================================================

// Quebra um texto grande em pedaços <= NOTION_LIMIT, sem cortar palavra.
function chunk(text, size = NOTION_LIMIT) {
  const parts = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(' ', size);
    if (cut < size * 0.5) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

function paragraph(content, bold = false) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { type: 'text', text: { content }, annotations: { bold } },
      ],
    },
  };
}

function heading(content) {
  return {
    object: 'block',
    type: 'heading_2',
    heading_2: { rich_text: [{ type: 'text', text: { content } }] },
  };
}

// Divide a letra em estrofes (linha em branco) -> array de strings.
function toStanzas(lyrics) {
  return lyrics
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Monta o array de blocks do Notion: estrofes + (opcional) seção de annotations.
function buildNotionChildren(lyrics, annotations) {
  const children = [];
  for (const stanza of toStanzas(lyrics)) {
    for (const piece of chunk(stanza)) children.push(paragraph(piece));
  }
  if (annotations.length) {
    children.push(heading('Annotations'));
    for (const a of annotations) {
      for (const piece of chunk(a.fragment)) children.push(paragraph(piece, true));
      for (const piece of chunk(a.annotation)) children.push(paragraph(piece));
    }
  }
  return children.slice(0, 100); // Notion aceita no máx. 100 blocks por chamada
}

// Corpo completo do POST https://api.notion.com/v1/pages (se ?db= for passado).
// Schema da base: Título (Title), Artista (Select), URL (URL), Lançamento (Date).
function buildNotionPayload(dbId, meta, children) {
  const properties = {
    'Título': { title: [{ text: { content: meta.title || 'Sem título' } }] },
    'Artista': {
      select: { name: (meta.artist || 'Desconhecido').replace(/,/g, ' ').trim() },
    },
    'URL': { url: meta.url || null },
  };
  if (meta.release_iso) {
    properties['Lançamento'] = { date: { start: meta.release_iso } };
  }
  return { parent: { database_id: dbId }, properties, children };
}

// Exportados só para testes unitários (não afetam o handler da Vercel).
export { slugify, toStanzas, buildNotionChildren, buildNotionPayload, chunk };

export default async function handler(req, res) {
  // Autenticação simples: só o seu Make consegue chamar
  if (req.headers['x-api-key'] !== MY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { artist, song, max = 20, db } = params;

  try {
    // MODO 1: música específica -> letra + blocos p/ Notion
    if (song) {
      if (!artist) {
        return res.status(400).json({ error: 'informe também ?artist=' });
      }
      const { songs } = await getArtistSongs(artist);
      const q = song.toLowerCase();
      const hit =
        songs.find((s) => s.title.toLowerCase() === q) ||
        songs.find((s) => s.title.toLowerCase().includes(q));
      if (!hit) return res.status(404).json({ error: 'song not found' });

      const lyrics = await scrapeLyrics(hit.url);
      const annotations = []; // Letras.mus.br não tem annotations verso a verso

      const meta = {
        title: hit.title,
        artist,
        url: hit.url,
        release_date: null,
        release_iso: null,
      };

      const stanzas = toStanzas(lyrics);
      const notion_children = buildNotionChildren(lyrics, annotations);
      const notion_payload = db
        ? buildNotionPayload(db, meta, notion_children)
        : null;

      return res.status(200).json({
        ...meta,
        lyrics,
        stanzas,
        annotations,
        annotations_count: annotations.length,
        notion_children,
        notion_payload,
      });
    }

    // MODO 2: só o artista -> lista de músicas (rápido, sem letra)
    if (artist) {
      const { slug, songs } = await getArtistSongs(artist);
      if (!songs.length) {
        return res
          .status(404)
          .json({ error: 'artist not found or no songs', slug });
      }
      const limited = songs.slice(0, Number(max));
      return res.status(200).json({
        artist,
        slug,
        count: limited.length,
        songs: limited.map((s) => ({
          title: s.title,
          url: s.url,
          release_date: null,
        })),
      });
    }

    return res.status(400).json({ error: 'informe ?artist= ou ?song=' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
