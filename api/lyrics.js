import * as cheerio from 'cheerio';

// Token gerado em https://genius.com/api-clients (Client Access Token)
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;
// Segredo compartilhado só entre esta função e o seu cenário do Make
const MY_SECRET = process.env.MY_SECRET;

const NOTION_LIMIT = 1900; // margem sob o limite de 2000 chars por bloco do Notion

// --- Busca genérica na API do Genius ---
async function geniusSearch(query) {
  const res = await fetch(
    `https://api.genius.com/search?q=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } }
  );
  const data = await res.json();
  return data?.response?.hits?.map((h) => h.result) ?? [];
}

// --- Descobre o ID do artista a partir do nome ---
async function getArtistId(artistName) {
  const results = await geniusSearch(artistName);
  const exact = results.find(
    (r) => r.primary_artist?.name?.toLowerCase() === artistName.toLowerCase()
  );
  const hit = exact || results[0];
  return hit ? hit.primary_artist.id : null;
}

// --- Lista as músicas do artista (ordenadas por popularidade) ---
async function getArtistSongs(artistId, max = 20) {
  const songs = [];
  let page = 1;
  while (songs.length < max) {
    const res = await fetch(
      `https://api.genius.com/artists/${artistId}/songs?per_page=50&page=${page}&sort=popularity`,
      { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } }
    );
    const data = await res.json();
    const batch = data?.response?.songs ?? [];
    if (!batch.length) break;
    // Só músicas em que o artista é o principal (evita "feats" de outros)
    songs.push(...batch.filter((s) => s.primary_artist?.id === artistId));
    if (!data.response.next_page) break;
    page = data.response.next_page;
  }
  return songs.slice(0, max);
}

// --- Extrai a letra da página do Genius ---
// Resiliente: qualquer falha de rede/parse devolve '' em vez de estourar,
// pra nunca quebrar o payload do Notion (critério de robustez do handoff).
async function scrapeLyrics(url) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return '';
    const html = await res.text();
    const $ = cheerio.load(html);
    let lyrics = '';
    $('[data-lyrics-container="true"]').each((_, el) => {
      $(el).find('br').replaceWith('\n'); // preserva quebras de linha
      lyrics += $(el).text() + '\n';
    });
    return lyrics.trim();
  } catch {
    return '';
  }
}

// --- Normaliza a data de lançamento para ISO YYYY-MM-DD ---
// O Genius devolve `release_date_components` {year, month, day} e um texto
// humano em `release_date_for_display`. A property Date do Notion exige ISO.
// Se não der pra derivar um ano, devolve null (a property é omitida no POST).
function normalizeReleaseDate(hit) {
  const c = hit?.release_date_components;
  if (c && c.year) {
    const y = String(c.year).padStart(4, '0');
    const m = String(c.month || 1).padStart(2, '0');
    const d = String(c.day || 1).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const disp = hit?.release_date_for_display;
  if (disp) {
    const t = Date.parse(disp); // fallback: "January 1, 2020"
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return null;
}

// --- Busca as annotations (explicações verso a verso) via API ---
// A API do Genius devolve os "referents": cada um tem um trecho da letra
// (fragment) e uma ou mais explicações (annotations[].body.plain).
async function getAnnotations(songId, max = 50) {
  const out = [];
  let page = 1;
  while (out.length < max) {
    const res = await fetch(
      `https://api.genius.com/referents?song_id=${songId}` +
        `&text_format=plain&per_page=50&page=${page}`,
      { headers: { Authorization: `Bearer ${GENIUS_TOKEN}` } }
    );
    if (!res.ok) break;
    const data = await res.json();
    const referents = data?.response?.referents ?? [];
    if (!referents.length) break;

    for (const ref of referents) {
      const fragment = (ref.fragment || '').trim();
      // Pega a explicação mais votada de cada trecho
      const best = (ref.annotations || [])
        .slice()
        .sort((a, b) => (b.votes_total ?? 0) - (a.votes_total ?? 0))[0];
      const explanation = best?.body?.plain?.trim();
      if (fragment && explanation) {
        out.push({
          fragment,
          annotation: explanation,
          votes: best.votes_total ?? 0,
          url: ref.url || null,
        });
      }
    }

    if (!data.response.next_page) break;
    page = data.response.next_page;
  }
  return out.slice(0, max);
}

// =====================================================================
//  Helpers do Notion — deixam o Make trivial: a função já devolve os
//  blocos prontos e (opcional) o corpo completo do POST /v1/pages.
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

// Monta o array de blocks do Notion: estrofes + seção de annotations.
function buildNotionChildren(lyrics, annotations) {
  const children = [];
  for (const stanza of toStanzas(lyrics)) {
    for (const piece of chunk(stanza)) children.push(paragraph(piece));
  }
  if (annotations.length) {
    children.push(heading('Annotations'));
    for (const a of annotations) {
      // trecho da letra em negrito
      for (const piece of chunk(a.fragment)) children.push(paragraph(piece, true));
      // explicação
      for (const piece of chunk(a.annotation)) children.push(paragraph(piece));
    }
  }
  return children.slice(0, 100); // Notion aceita no máx. 100 blocks por chamada
}

// Corpo completo do POST https://api.notion.com/v1/pages (se ?db= for passado).
// Schema real da base: Título (Title), Artista (Select), URL (URL),
// Lançamento (Date). Ajuste os NOMES aqui se renomear colunas na sua base.
function buildNotionPayload(dbId, meta, children) {
  const properties = {
    'Título': { title: [{ text: { content: meta.title || 'Sem título' } }] },
    // Select: o Notion cria a opção sozinho se ela ainda não existir.
    // Nome de opção não pode conter vírgula — troca por espaço por segurança.
    'Artista': {
      select: { name: (meta.artist || 'Desconhecido').replace(/,/g, ' ').trim() },
    },
    'URL': { url: meta.url || null },
  };
  // Date só entra se tivermos um ISO válido; senão a property é omitida
  // (mandar valor inválido faria o POST voltar 400).
  if (meta.release_iso) {
    properties['Lançamento'] = { date: { start: meta.release_iso } };
  }
  return { parent: { database_id: dbId }, properties, children };
}

// Exportados só para testes unitários (não afetam o handler da Vercel).
export { toStanzas, buildNotionChildren, buildNotionPayload, chunk, normalizeReleaseDate };

export default async function handler(req, res) {
  // Autenticação simples: só o seu Make consegue chamar
  if (req.headers['x-api-key'] !== MY_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const params = req.method === 'POST' ? req.body : req.query;
  const { artist, song, max = 20, db } = params;
  // annotations vêm ligadas por padrão; passe annotations=0 pra desligar
  const wantAnnotations = String(params.annotations ?? '1') !== '0';

  try {
    // MODO 1: música específica -> letra + annotations + blocos p/ Notion
    if (song) {
      // Preferência: achar a música na lista do próprio artista (mais
      // confiável que a busca textual, que às vezes traz outro artista).
      let hit = null;
      if (artist) {
        const artistId = await getArtistId(artist);
        if (artistId) {
          const songs = await getArtistSongs(artistId, 200);
          const q = song.toLowerCase();
          hit =
            songs.find((s) => s.title?.toLowerCase() === q) ||
            songs.find((s) => s.title?.toLowerCase().includes(q));
        }
      }
      // Fallback: busca textual, priorizando o hit cujo artista corresponde.
      if (!hit) {
        const results = await geniusSearch(`${artist || ''} ${song}`.trim());
        hit =
          (artist &&
            results.find(
              (r) => r.primary_artist?.name?.toLowerCase() === artist.toLowerCase()
            )) ||
          results[0];
      }
      if (!hit) return res.status(404).json({ error: 'song not found' });

      const lyrics = await scrapeLyrics(hit.url);
      const annotations = wantAnnotations
        ? await getAnnotations(hit.id, Number(params.max_annotations ?? 50))
        : [];

      const meta = {
        title: hit.title,
        artist: hit.primary_artist.name,
        url: hit.url,
        release_date: hit.release_date_for_display || null,
        release_iso: normalizeReleaseDate(hit),
      };

      const stanzas = toStanzas(lyrics);
      const notion_children = buildNotionChildren(lyrics, annotations);
      // Se o Make passar ?db=<database_id>, já devolvemos o corpo pronto do POST.
      const notion_payload = db ? buildNotionPayload(db, meta, notion_children) : null;

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

    // MODO 2: só o artista -> devolve a lista de músicas (rápido, sem letra)
    if (artist) {
      const artistId = await getArtistId(artist);
      if (!artistId) return res.status(404).json({ error: 'artist not found' });
      const songs = await getArtistSongs(artistId, Number(max));
      return res.status(200).json({
        artist,
        count: songs.length,
        songs: songs.map((s) => ({
          title: s.title,
          url: s.url,
          release_date: s.release_date_for_display || null,
        })),
      });
    }

    return res.status(400).json({ error: 'informe ?artist= ou ?song=' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
