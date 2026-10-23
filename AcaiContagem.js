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
