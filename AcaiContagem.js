// ============================================================
//  AÇAÍ NA CUIA — CONTAGEM DIÁRIA = INVENTÁRIO AUTOMÁTICO
// ============================================================
// O estoque do Açaí é contado TODO DIA, então todo dia tem inventário: ninguém precisa montar e salvar
// inventário em Ajustes. Cada dia com contagem concluída vira um inventário automático da unidade
// (id "AUTO-<id da contagem>"), que entra em obterInventariosSalvos_ só no negócio Açaí na Cuia.
//
// Dois cuidados:
//  - Só a ÚLTIMA contagem de cada dia vale. O Estoquista conta a lista inteira, então duas contagens no
//    mesmo dia são a mesma coisa recontada (turno, correção) e SOMAR dobraria o estoque.
//  - Só entram contagens CONCLUIDO ou com DIVERGENCIA (a divergência é da separação; o estoque contado
//    é válido). Contagem em andamento não entra.
var ACAI_UNIDADE_CONTAGEM = 'ACAI NA CUIA';
var CONTAGENS_ACAI_MEMO_ = undefined;   // vale só durante a execução

// ABERTURA COM ESTOQUE ZERO: a unidade começou a operar em outubro/2026 e não existe contagem de setembro. Combinado com o
// cliente: o estoque inicial é R$ 0 em 30/09/2026. Vira uma "contagem" sintética (sem itens) nessa data, e assim o CMV
// do mês, das semanas e do dia enxergam o estoque inicial zero sem ninguém digitar nada. Só vale se não houver contagem
// real nessa data ou antes dela.
var ACAI_ABERTURA_ZERO = { ts: '20260930', id: 'ABERTURA-ZERO' };

function aberturasZeroEstoque_() {
  if (NEGOCIO_ATIVO !== 'ACAI NA CUIA') return [];
  var ts = ACAI_ABERTURA_ZERO.ts;
  var real = contagensDiariasAcai_().filter(function(c) { return !c.sintetica; });
  if (real.length && real[0].ts <= ts) return [];
  return [{ unidade: ACAI_UNIDADE_CONTAGEM, ts: ts, ano: Number(ts.slice(0, 4)), mes: Number(ts.slice(4, 6)), dia: Number(ts.slice(6, 8)) }];
}

// 'dd/MM/yyyy HH:mm' -> 'yyyyMMddHHmm' (ordenável); sem hora -> 0000
function chaveDataHoraContagem_(txt) {
  var s = String(txt == null ? '' : txt).trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  return m[3] + pad2(m[2]) + pad2(m[1]) + pad2(m[4] || 0) + pad2(m[5] || 0);
}

// [{ id, ano, mes, dia, ts:'yyyyMMdd', data:'dd/MM/yyyy', hora:'yyyyMMddHHmm' }] — uma por dia, ordenada por data.
function contagensDiariasAcai_() {
  if (CONTAGENS_ACAI_MEMO_ !== undefined) return CONTAGENS_ACAI_MEMO_;
  var porDia = {};
  try {
    var aba = SpreadsheetApp.openById(CONTAGEM_SHEET_ID).getSheetByName('CONTAGENS');
    var rows = aba ? aba.getDataRange().getValues() : [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      if (String(r[2]).trim() !== ACAI_UNIDADE_CONTAGEM) continue;
      var status = String(r[6] || '').trim().toUpperCase();
      if (status !== 'CONCLUIDO' && status !== 'DIVERGENCIA') continue;
      var texto = (typeof paraTextoData_ === 'function') ? (paraTextoData_(r[1]) || paraTextoData_(r[7])) : String(r[1]);
      var hora = chaveDataHoraContagem_(texto);
      if (!hora) continue;
      var ts = hora.slice(0, 8);
      var atual = porDia[ts];
      // a mais recente do dia; empate fica com a que veio depois na planilha
      if (!atual || hora >= atual.hora) {
        porDia[ts] = { id: String(r[0]).trim(), ano: Number(ts.slice(0, 4)), mes: Number(ts.slice(4, 6)), dia: Number(ts.slice(6, 8)),
                       ts: ts, data: ts.slice(6, 8) + '/' + ts.slice(4, 6) + '/' + ts.slice(0, 4), hora: hora };
      }
    }
  } catch (err) {
    Logger.log('Contagens diárias do Açaí indisponíveis: ' + err.message);
  }
  var lista = Object.keys(porDia).sort().map(function(k) { return porDia[k]; });
  var tsZ = ACAI_ABERTURA_ZERO.ts;
  if (lista.length && lista[0].ts > tsZ) {
    lista.unshift({ id: ACAI_ABERTURA_ZERO.id, ano: Number(tsZ.slice(0, 4)), mes: Number(tsZ.slice(4, 6)), dia: Number(tsZ.slice(6, 8)),
                    ts: tsZ, data: tsZ.slice(6, 8) + '/' + tsZ.slice(4, 6) + '/' + tsZ.slice(0, 4), hora: tsZ + '0000', sintetica: true });
  }
  CONTAGENS_ACAI_MEMO_ = lista;
  return lista;
}

// Inventários automáticos no mesmo formato dos salvos à mão ({id, label, unidade, contagemIds}).
function inventariosAutoAcai_() {
  return contagensDiariasAcai_().map(function(c) {
    return { id: 'AUTO-' + c.id, label: 'Contagem ' + c.data, unidade: ACAI_UNIDADE_CONTAGEM, contagemIds: [c.id], auto: true };
  });
}

// Itens de várias contagens numa ÚNICA leitura da aba (buscarItensDeContagens_ lê a aba inteira a cada
// chamada; pra montar o CMV de 90 dias seriam 90 leituras). Devolve { contagemId: [{produto, cod, und, qtde}] }.
function lerItensPorContagem_(contagemIds) {
  var validos = {};
  contagemIds.forEach(function(id) { validos[String(id).trim()] = true; });
  var aba = SpreadsheetApp.openById(CONTAGEM_SHEET_ID).getSheetByName('ITENS_CONTAGEM');
  if (!aba) throw new Error('Aba ITENS_CONTAGEM não encontrada na planilha.');
  var rows = aba.getDataRange().getValues();
  var porId = {};
  for (var j = 1; j < rows.length; j++) {
    var r = rows[j];
    var cid = String(r[C_ITENS_CONTAGEM.contagemId]).trim();
    if (!validos[cid]) continue;
    var produto = String(r[C_ITENS_CONTAGEM.produto]).trim();
    if (!produto) continue;
    var cod = String(r[C_ITENS_CONTAGEM.cod] || '').trim();
    var chave = cod || produto;
    var mapa = porId[cid] = porId[cid] || {};
    if (!mapa[chave]) mapa[chave] = { produto: produto, cod: cod, und: String(r[C_ITENS_CONTAGEM.und] || '').trim(), qtde: 0, fontes: [] };
    mapa[chave].qtde += Number(r[C_ITENS_CONTAGEM.contado]) || 0;
    mapa[chave].fontes.push({ contagemId: cid, linha: j + 1 });
  }
  var out = {};
  Object.keys(porId).forEach(function(cid) { out[cid] = Object.keys(porId[cid]).map(function(k) { return porId[cid][k]; }); });
  return out;
}

// ── SEMANAS AUTOMÁTICAS DO MÊS (segunda a domingo, recortadas ao mês) ──
// O Açaí não configura semana nenhuma: Semana 1, 2, 3... são as semanas de calendário (segunda a domingo) que tocam o
// mês, cortadas nas pontas (a Semana 1 começa no dia 1 e a última termina no último dia do mês, então a soma das
// semanas é o mês). Semana que ainda não começou não aparece; a semana corrente vai até hoje.
//
// Cada semana vira um "registro de semana salva" pro cálculo existente (calcularAnaliseSemanal):
//  - com contagens: EI = última contagem ANTES da semana (até 10 dias antes), EF = última até o fim da semana (ou até hoje).
//    O período de compras e vendas é (data do EI, data do EF], como no CMV diário; com contagem todo dia é a semana exata;
//    se faltou contagem, o intervalo cresce e as datas mostradas dizem qual foi.
//  - sem contagens: semContagem = true. Mostra CMC e faturamento da semana, sem CMV real.
// hojeMs: só pra teste; em produção é "agora".
function semanasAutomaticasAcai_(mesNome, ano, hojeMs) {
  var mesIdx = ORDEM_MESES.indexOf(mesNome);
  if (mesIdx < 0) return [];
  var total = diasNoMes(mesNome, ano);
  var chaveDe = function(d) { return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()); };
  var isoDe = function(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };
  var hoje = new Date(hojeMs === undefined ? new Date().getTime() : hojeMs);
  var hojeKey = chaveDe(hoje);
  var primeiro = new Date(ano, mesIdx, 1), ultimo = new Date(ano, mesIdx, total);
  var contagens = contagensDiariasAcai_();
  var out = [];
  enumerarSemanasCalendario_(mesNome, ano).forEach(function(w, idx) {
    var seg = new Date(w.segunda.ano, w.segunda.mes - 1, w.segunda.dia), dom = new Date(w.domingo.ano, w.domingo.mes - 1, w.domingo.dia);
    var ini = seg < primeiro ? primeiro : seg;
    var fim = dom > ultimo ? ultimo : dom;
    var iniKey = chaveDe(ini);
    if (iniKey > hojeKey) return;                                  // semana que ainda não começou
    var fimKey = chaveDe(fim) > hojeKey ? hojeKey : chaveDe(fim);   // semana corrente: até hoje
    var fimEf = chaveDe(fim) > hojeKey ? hoje : fim;
    var janelaKey = chaveDe(new Date(ini.getFullYear(), ini.getMonth(), ini.getDate() - 10));
    var ei = null, ef = null;
    contagens.forEach(function(c) {
      if (c.ts < iniKey && c.ts >= janelaKey) ei = c;
      if (c.ts <= fimKey) ef = c;
    });
    var s = { id: 'AUTO-SEM-' + (idx + 1), mes: mesNome, ano: ano, semanaNum: idx + 1, unidade: ACAI_UNIDADE_CONTAGEM, auto: true };
    if (ei && ef && ef.ts >= iniKey && ef.ts > ei.ts) {
      var diaSeg = new Date(Number(ei.ts.slice(0, 4)), Number(ei.ts.slice(4, 6)) - 1, Number(ei.ts.slice(6, 8)) + 1);
      s.inventarioInicialId = 'AUTO-' + ei.id; s.inventarioFinalId = 'AUTO-' + ef.id;
      s.periodoAuto = { ini: isoDe(diaSeg), fim: ef.ts.slice(0, 4) + '-' + ef.ts.slice(4, 6) + '-' + ef.ts.slice(6, 8) };
    } else {
      s.semContagem = true;
      s.periodoAuto = { ini: isoDe(ini), fim: isoDe(fimEf) };
    }
    out.push(s);
  });
  return out;
}
