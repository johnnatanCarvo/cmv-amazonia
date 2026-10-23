// ── TRANSFERÊNCIAS DO AÇAÍ NA CUIA PARA AS UNIDADES ──────────────────────────
// O Açaí abastece Umarizal, Marco e Porto Futuro por pedido de venda
// "Transferência para filiais". Em outubro/2026 esses pedidos não eram
// expedidos no Cloudfy: não geravam saída de estoque no Açaí nem nota de compra
// na unidade, então a API não tinha como mostrar o açaí que saiu.
//
// Esta tabela carrega o histórico (61 pedidos, 02 a 22/10/2026, tudo açaí a
// R$ 20 o litro, preço informado pelo cliente). Dentro dessa janela ela manda
// sobre qualquer nota do Açaí que a API traga (as 380 L de Porto Futuro a R$ 22
// são parte destes mesmos pedidos). Depois de 22/10 vale o que o Cloudfy trouxer.
//
// Como cada negócio enxerga a transferência:
//   Amazônia na Cuia: o açaí é COMPRA EXTERNA (vem de fora do negócio), valorizada
//                     pelo preço do pedido.
//   Açaí na Cuia:     é SAÍDA do estoque, valorizada pelo CUSTO de produção do
//                     litro (o estoque contado está a custo; a R$ 20 o CMV ficaria
//                     subavaliado). O faturamento do Açaí continua só o varejo.
var FILIAL_ACAI = 'ACAI NA CUIA';
var TRANSF_ACAI_PRECO_LITRO = 20;
var TRANSF_ACAI_COD = '1238';

// [data, nº do pedido, filial de destino, valor do pedido em R$]
var TRANSF_ACAI_PEDIDOS = [
  ['02/10/2026', 1, 'UMARIZAL', 400.00],
  ['03/10/2026', 10, 'UMARIZAL', 600.00],
  ['03/10/2026', 11, 'UMARIZAL', 1080.00],
  ['03/10/2026', 12, 'MARCO', 1000.00],
  ['03/10/2026', 13, 'PORTO FUTURO', 1400.00],
  ['04/10/2026', 6, 'PORTO FUTURO', 1239.60],
  ['04/10/2026', 7, 'MARCO', 920.00],
  ['04/10/2026', 8, 'UMARIZAL', 860.00],
  ['06/10/2026', 17, 'PORTO FUTURO', 700.00],
  ['06/10/2026', 18, 'UMARIZAL', 810.00],
  ['06/10/2026', 19, 'MARCO', 1400.00],
  ['07/10/2026', 14, 'MARCO', 1400.00],
  ['07/10/2026', 15, 'UMARIZAL', 860.00],
  ['07/10/2026', 16, 'PORTO FUTURO', 1000.00],
  ['07/10/2026', 30, 'PORTO FUTURO', 139.30],
  ['07/10/2026', 31, 'UMARIZAL', 139.30],
  ['07/10/2026', 32, 'MARCO', 139.30],
  ['08/10/2026', 20, 'MARCO', 1000.00],
  ['08/10/2026', 21, 'UMARIZAL', 230.00],
  ['08/10/2026', 22, 'PORTO FUTURO', 800.00],
  ['09/10/2026', 23, 'MARCO', 2500.00],
  ['09/10/2026', 24, 'UMARIZAL', 1400.00],
  ['09/10/2026', 25, 'PORTO FUTURO', 2000.00],
  ['10/10/2026', 26, 'UMARIZAL', 1700.00],
  ['10/10/2026', 27, 'MARCO', 2700.00],
  ['10/10/2026', 28, 'PORTO FUTURO', 3640.00],
  ['11/10/2026', 40, 'MARCO', 1920.00],
  ['11/10/2026', 41, 'UMARIZAL', 2440.00],
  ['11/10/2026', 42, 'PORTO FUTURO', 1800.00],
  ['12/10/2026', 34, 'MARCO', 111.44],
  ['12/10/2026', 43, 'UMARIZAL', 1140.00],
  ['12/10/2026', 44, 'MARCO', 1400.00],
  ['12/10/2026', 45, 'PORTO FUTURO', 1050.00],
  ['13/10/2026', 46, 'UMARIZAL', 1560.00],
  ['13/10/2026', 47, 'MARCO', 1600.00],
  ['13/10/2026', 48, 'PORTO FUTURO', 1200.00],
  ['14/10/2026', 49, 'UMARIZAL', 900.00],
  ['14/10/2026', 50, 'MARCO', 660.00],
  ['14/10/2026', 51, 'PORTO FUTURO', 600.00],
  ['15/10/2026', 52, 'UMARIZAL', 800.00],
  ['15/10/2026', 53, 'MARCO', 960.00],
  ['15/10/2026', 54, 'PORTO FUTURO', 900.00],
  ['16/10/2026', 35, 'UMARIZAL', 600.00],
  ['16/10/2026', 36, 'MARCO', 500.00],
  ['16/10/2026', 37, 'PORTO FUTURO', 420.00],
  ['17/10/2026', 55, 'UMARIZAL', 690.00],
  ['17/10/2026', 56, 'PORTO FUTURO', 2030.00],
  ['17/10/2026', 57, 'MARCO', 1200.00],
  ['18/10/2026', 58, 'UMARIZAL', 1500.00],
  ['18/10/2026', 59, 'PORTO FUTURO', 1200.00],
  ['18/10/2026', 60, 'MARCO', 1800.00],
  ['19/10/2026', 61, 'UMARIZAL', 520.00],
  ['20/10/2026', 62, 'MARCO', 1160.00],
  ['20/10/2026', 63, 'UMARIZAL', 800.00],
  ['20/10/2026', 64, 'PORTO FUTURO', 400.00],
  ['21/10/2026', 65, 'UMARIZAL', 160.00],
  ['21/10/2026', 66, 'MARCO', 420.00],
  ['21/10/2026', 67, 'PORTO FUTURO', 400.00],
  ['22/10/2026', 68, 'PORTO FUTURO', 900.00],
  ['22/10/2026', 69, 'MARCO', 510.00],
  ['22/10/2026', 70, 'MARCO', 170.00]
];

// Filial de origem de uma linha de compra, ou null se não for transferência.
// Cobre "AMAZONIA NA CUIA <ORIGEM>" (marcador antigo) e o nome puro "ACAI NA CUIA",
// que é como o Cloudfy traz o Açaí como fornecedor nas notas das unidades.
function origemTransferencia_(fornecedor) {
  var f = String(fornecedor || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!f) return null;
  if (f.indexOf(TRANSFERENCIA_MARCADOR) >= 0) return filialOrigem(fornecedor);
  if (f === FILIAL_ACAI) return FILIAL_ACAI;
  return null;
}

// Como a linha se comporta no negócio ativo: null = compra externa normal;
// { origem, entra, sai } = transferência. `entra` diz se o destino pertence ao
// negócio (só então a unidade registra a entrada); a saída é sempre da origem.
function classificarTransferencia_(fornecedor, filialDestino) {
  var orig = origemTransferencia_(fornecedor);
  if (!orig || orig === filialDestino) return null;
  if (orig === FILIAL_ACAI) {
    // Para o Amazônia o Açaí é fornecedor de fora. Só o Açaí enxerga a saída.
    if (NEGOCIO_ATIVO !== 'ACAI NA CUIA') return null;
    return { origem: orig, entra: filialDoNegocioAtivo_(filialDestino), sai: true };
  }
  return { origem: orig, entra: true, sai: true };
}

function chaveDataBR_(s) {
  s = String(s || '').trim();
  return s.length >= 10 ? s.slice(6, 10) + s.slice(3, 5) + s.slice(0, 2) : '';
}

// Os pedidos no layout de uma linha de compras (C_COMPRAS), na filial de destino.
function linhasTransferenciasAcai_() {
  var grupo = 'ACAI';
  try { if (typeof cfyMapaGrupos_ === 'function') grupo = cfyMapaGrupos_(null)[TRANSF_ACAI_COD] || grupo; } catch (e) {}
  return TRANSF_ACAI_PEDIDOS.map(function(p) {
    var linha = new Array(18);
    for (var k = 0; k < 18; k++) linha[k] = '';
    linha[C_COMPRAS.filial]      = p[2];
    linha[C_COMPRAS.data]        = p[0];
    linha[C_COMPRAS_FORNECEDOR]  = FILIAL_ACAI;
    linha[C_COMPRAS.cod]         = TRANSF_ACAI_COD;
    linha[C_COMPRAS.produto]     = ACAI_NOME_MEDIO;
    linha[C_COMPRAS.grupo]       = grupo;
    linha[C_COMPRAS.qtd]         = Math.round(p[3] / TRANSF_ACAI_PRECO_LITRO * 10000) / 10000;
    linha[C_COMPRAS.unid]        = 'LT';
    linha[C_COMPRAS.custo_atual] = TRANSF_ACAI_PRECO_LITRO;
    linha[C_COMPRAS.total]       = p[3];
    return linha;
  });
}

// Troca, na janela dos pedidos, as notas do Açaí que a API/CSV trouxeram pelas
// linhas desta tabela. `rows` ainda sem filtro de negócio.
function aplicarTransferenciasAcai_(rows) {
  if (!rows || !rows.length) return rows;
  var sup = linhasTransferenciasAcai_();
  if (!sup.length) return rows;
  var ini = '99999999', fim = '00000000';
  sup.forEach(function(l) {
    var k = chaveDataBR_(l[C_COMPRAS.data]);
    if (k < ini) ini = k;
    if (k > fim) fim = k;
  });
  var out = [rows[0]];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    var k = chaveDataBR_(r[C_COMPRAS.data]);
    var filial = String(r[C_COMPRAS.filial] || '').trim().toUpperCase();
    if (filial !== FILIAL_ACAI && k >= ini && k <= fim && origemTransferencia_(r[C_COMPRAS_FORNECEDOR]) === FILIAL_ACAI) continue;
    out.push(r);
  }
  return out.concat(sup);
}

function filialConhecida_(nome) {
  var n = String(nome || '').trim().toUpperCase();
  return Object.keys(NEGOCIOS).some(function(k) {
    return NEGOCIOS[k].filiais.some(function(f) { return f.toUpperCase() === n; });
  });
}

// Filtro de negócio das COMPRAS. Igual ao filtrarNegocio_, mais as linhas das
// unidades que vieram do Açaí quando o negócio ativo é o Açaí (são as saídas
// dele), valorizadas pelo custo de produção do litro.
function filtrarComprasNegocio_(rows) {
  rows = aplicarTransferenciasAcai_(rows);
  var base = filtrarNegocio_(rows, C_COMPRAS.filial);
  if (NEGOCIO_ATIVO !== 'ACAI NA CUIA' || !rows || rows.length < 2) return base;

  var extras = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r) continue;
    var filial = String(r[C_COMPRAS.filial] || '').trim();
    if (filialDoNegocioAtivo_(filial) || !filialConhecida_(filial)) continue;
    if (origemTransferencia_(r[C_COMPRAS_FORNECEDOR]) !== FILIAL_ACAI) continue;
    extras.push(r.slice());
  }
  if (!extras.length) return base;

  var custos = preAgregarCustoMedioPorInsumo(base);   // sem as saídas: o custo vem da lata e da produção
  extras.forEach(function(r) {
    var prod = String(r[C_COMPRAS.produto] || '').trim();
    if (prod !== ACAI_NOME_MEDIO && prod !== ACAI_NOME_GROSSO) return;
    var d = parseDataCompleta(r[C_COMPRAS.data]);
    var qtd = numVal(r[C_COMPRAS.qtd]);
    if (!d || qtd <= 0) return;
    var custo = buscarCustoInsumoComFallback(custos, prod, ORDEM_MESES[d.mes - 1], d.ano);
    if (custo === null || custo === undefined || custo <= 0) return;   // sem custo medido: mantém o valor do pedido
    r[C_COMPRAS.custo_atual] = custo;
    r[C_COMPRAS.total]       = qtd * custo;
  });
  return base.concat(extras);
}
