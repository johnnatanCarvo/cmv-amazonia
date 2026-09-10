// ============================================================
//  CARVO Consultoria | Amazônia na Cuia — Painel Analítico
//  Code.gs — Ponto de entrada do Apps Script
//  Versão: 1.1
// ============================================================


// ── CONFIGURAÇÃO ─────────────────────────────────────────────
var PASTA_ID = '1XS4NKNDUf4NJaCp_ajjr2K5g0CUYilT1';

// Identificador da versão publicada -- bumped a cada deploy (clasp deploy).
// O front-end grava esse valor no carregamento da página (embutido no HTML
// pelo template, ver <?= VERSAO_APP ?> em Index.html) e, de tempos em
// tempos, pergunta pro servidor (obterVersaoApp) qual é o valor ATUAL. Se
// mudou, é porque alguém (eu) publicou uma atualização enquanto a página
// já estava aberta -- aí mostra um aviso pra recarregar, em vez de deixar
// a pessoa usando uma versão desatualizada sem saber.
var VERSAO_APP = '2026-09-10.1';

function obterVersaoApp() {
  return JSON.stringify({ ok: true, versao: VERSAO_APP });
}

// ── SEGURANÇA ────────────────────────────────────────────────
// A senha NAO fica no codigo-fonte (este projeto e versionado no GitHub).
// Ela mora em Project Settings > Script Properties, chave "SENHA_ACESSO".
// Para definir ou trocar a senha: Configuracoes do projeto (engrenagem) no
// editor do Apps Script > Propriedades do script > Adicionar propriedade do script.

// Valida a senha enviada pelo frontend. Retorna true ou false.
function validarSenha(senha) {
  var senhaConfigurada = PropertiesService.getScriptProperties().getProperty('SENHA_ACESSO');
  if (!senhaConfigurada) {
    Logger.log('SENHA_ACESSO nao configurada em Script Properties.');
    return false;
  }
  return String(senha) === senhaConfigurada;
}

// Padrões de nome dos arquivos — o script lê TODOS os CSVs
// que contenham esses termos no nome, de qualquer mês.
// Exemplos de nomes aceitos:
//   compras_janeiro.csv | compras_fev_2026.csv | compras.csv
//   vendas_marco.csv    | vendas_03_2026.csv   | vendas.csv
//   estoque_abril.csv   | contagem_mai.csv      | estoque.csv
var PADROES = {
  compras: /compras/i,
  vendas:  /vendas/i,
  estoque: /estoque|contagem/i,
  fichas:  /^fichas/i
};

// ── SERVIDOR ─────────────────────────────────────────────────

function doGet(e) {
  // ?app=fichas abre o editor de fichas técnicas (mobile, senha própria) --
  // mesmo projeto/deployment, view totalmente separada do dashboard.
  if (e && e.parameter && e.parameter.app === 'fichas') {
    return HtmlService.createTemplateFromFile('Fichas')
      .evaluate()
      .setTitle('Fichas Técnicas | Amazônia na Cuia | CARVO')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('CMC + CMV | Amazônia na Cuia | CARVO')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getPayload(senha) {
  // Trava de seguranca: sem senha valida, nao retorna dados
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var rowsCompras = lerTodosCSVs('compras');
    var rowsVendas  = lerTodosCSVs('vendas');
    var rowsEstoque = lerTodosCSVs('estoque');
    var rowsFichas  = lerFichaTecnica(); // opcional — [] se ainda nao foi enviada

    var cmc        = processarCompras(rowsCompras);
    var vendas     = processarVendas(rowsVendas);
    var fichasMap  = processarFichas(rowsFichas);
    var receitas   = processarReceitas(rowsFichas);

    // Custo médio de compra de cada insumo por mês — usado tanto pro CMV
    // Teórico (reprecificação) quanto pra precificar o inventário salvo
    // (Ajustes > Inventário) na conexão com o CMV/CMC logo abaixo.
    var historicoPorInsumo = preAgregarCustoMedioPorInsumo(rowsCompras);

    // Conecta o CONTADO do sistema de contagem separado (Ajustes >
    // Inventário) no CMV/CMC: gera linhas de estoque sintéticas SÓ pros
    // meses que ainda não têm contagem via CSV — meses já calculados hoje
    // a partir do CSV continuam exatamente como estavam (ver comentário de
    // gerarLinhasEstoqueDeInventariosSalvos_).
    var inventarioConectado = gerarLinhasEstoqueDeInventariosSalvos_(rowsEstoque, rowsCompras, rowsVendas, historicoPorInsumo, fichasMap, rowsFichas);
    if (inventarioConectado.avisos.length) {
      Logger.log('Inventário salvo -> CMV: ' + inventarioConectado.avisos.join(' | '));
    }
    var rowsEstoqueCompleto = (rowsEstoque && rowsEstoque.length ? rowsEstoque : [[]]).concat(inventarioConectado.linhas);

    var cmv        = processarCMV(rowsEstoqueCompleto, rowsCompras, historicoPorInsumo, fichasMap);

    // Meses disponíveis — derivados dos dados de compras
    var mOrdem = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                  'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
    var meses = mOrdem.filter(function(m) { return cmc[m]; });
    var anoPorMes = inferirAnoPorMes(rowsCompras, meses);

    var produtosMenuEscolha = obterProdutosMenuEscolha();
    var cmvTeorico = calcularCMVTeorico(vendas, fichasMap, produtosMenuEscolha, receitas, historicoPorInsumo, anoPorMes);
    var demandaInsumos = calcularDemandaInsumos(vendas, receitas);
    var reconciliacaoInsumos = reconciliarInsumos(demandaInsumos, receitas);

    // Faturamento por mês a partir das vendas (by_mes)
    var fatPorMes = {};
    if (vendas && vendas.by_mes) {
      vendas.by_mes.forEach(function(item) {
        fatPorMes[item.mes] = item.valor;
      });
    }

    // Faturamento por mês + filial
    var fatMesFilial = (vendas && vendas.by_mes_filial) ? vendas.by_mes_filial : {};

    // Injetar faturamento no CMC a partir das vendas do mes
    meses.forEach(function(m) {
      var fat = fatPorMes[m] || 0;
      if (fat > 0) {
        cmc[m].faturamento = fat;
        cmc[m].cmc_pct_fat = cmc[m].cmc_total
          ? Math.round(cmc[m].cmc_total / fat * 10000) / 100
          : null;
        if (cmv[m]) {
          cmv[m].faturamento = fat;
          if (cmv[m].cmv_total) {
            cmv[m].cmv_pct = Math.round(cmv[m].cmv_total / fat * 10000) / 100;
          }
        }
      }
      // Faturamento por filial dentro do mês (CMC)
      if (fatMesFilial[m] && cmc[m].filiais) {
        Object.keys(cmc[m].filiais).forEach(function(fil) {
          var fatFil = fatMesFilial[m][fil] || 0;
          var filObj = cmc[m].filiais[fil];
          filObj.faturamento = fatFil;
          filObj.cmc_pct_fat = (fatFil > 0)
            ? Math.round(filObj.cmc_total / fatFil * 10000) / 100
            : null;
          // CMC considerando a transferencia recebida de outra unidade como
          // se fosse compra externa (cmc_total, por padrao, NAO inclui transferencia).
          var entradaVal = filObj.transf_entrada || 0;
          filObj.cmc_com_transf = Math.round((filObj.cmc_total + entradaVal) * 100) / 100;
          filObj.cmc_pct_fat_com_transf = (fatFil > 0)
            ? Math.round(filObj.cmc_com_transf / fatFil * 10000) / 100
            : null;
        });
      }
      // Faturamento por filial dentro do CMV.
      // IMPORTANTE: o CMV da filial que vem do Dados.gs JA considera a transferencia
      // (compras liquidas = compras com entrada embutida, menos a saida).
      // Aqui apenas calculamos os percentuais sobre o faturamento. Nao reaplicar o ajuste.
      if (cmv[m] && cmv[m].filiais && fatMesFilial[m]) {
        Object.keys(cmv[m].filiais).forEach(function(fil) {
          var fatFil = fatMesFilial[m][fil] || 0;
          cmv[m].filiais[fil].faturamento = fatFil;

          // Percentual do CMV (ja ajustado) sobre o faturamento
          cmv[m].filiais[fil].cmv_pct = (fatFil > 0)
            ? Math.round(cmv[m].filiais[fil].cmv / fatFil * 10000) / 100
            : null;
          // Percentual do CMV SEM descontar a saida (para o card de impacto)
          var cmvSemAj = cmv[m].filiais[fil].cmv_sem_ajuste;
          cmv[m].filiais[fil].cmv_pct_sem_ajuste = (fatFil > 0 && cmvSemAj !== undefined)
            ? Math.round(cmvSemAj / fatFil * 10000) / 100
            : null;
          // Percentual do CMV PURO (totalmente sem transferencia) sobre o faturamento
          var cmvPuroV = cmv[m].filiais[fil].cmv_puro;
          cmv[m].filiais[fil].cmv_pct_puro = (fatFil > 0 && cmvPuroV !== undefined)
            ? Math.round(cmvPuroV / fatFil * 10000) / 100
            : null;
        });
      }

      // CMV Teórico: percentual sobre faturamento e comparação com o CMV Real do mesmo mês.
      // "diferenca" e so a subtracao (real - teorico) — NAO e um indicador de perda/
      // desperdicio por si so (pode refletir producao nao vendida, variacao de
      // rendimento, etc.). Cabe a quem le interpretar com o contexto do negocio.
      if (cmvTeorico[m]) {
        var tObj = cmvTeorico[m];
        tObj.faturamento = fat;
        // O percentual usa o faturamento COBERTO (total menos as vendas sem
        // ficha tecnica) como base — dividir pelo faturamento total diluiria
        // o percentual pra baixo artificialmente, ja que vendas sem ficha
        // entram no denominador mas contribuem R$0 no teorico.
        var fatCoberto = fat - (tObj.sem_ficha_valor || 0);
        tObj.faturamento_coberto = Math.round(fatCoberto * 100) / 100;
        tObj.teorico_pct = (fatCoberto > 0)
          ? Math.round(tObj.teorico_total / fatCoberto * 10000) / 100
          : null;
        tObj.sem_ficha_pct = (fat > 0)
          ? Math.round((tObj.sem_ficha_valor || 0) / fat * 10000) / 100
          : null;
        tObj.sem_ficha_menu_pct = (fat > 0)
          ? Math.round((tObj.sem_ficha_valor_menu || 0) / fat * 10000) / 100
          : null;
        tObj.sem_ficha_cadastro_pct = (fat > 0)
          ? Math.round((tObj.sem_ficha_valor_cadastro || 0) / fat * 10000) / 100
          : null;
        if (cmv[m] && cmv[m].cmv_total !== undefined) {
          tObj.real_total = cmv[m].cmv_total;
          tObj.real_pct   = cmv[m].cmv_pct;
          tObj.diferenca  = Math.round((cmv[m].cmv_total - tObj.teorico_total) * 100) / 100;
        }
        if (fatMesFilial[m] && tObj.filiais) {
          Object.keys(tObj.filiais).forEach(function(fil) {
            var fatFil = fatMesFilial[m][fil] || 0;
            var fObj = tObj.filiais[fil];
            fObj.faturamento = fatFil;
            var fatFilCoberto = fatFil - (fObj.sem_ficha_valor || 0);
            fObj.faturamento_coberto = Math.round(fatFilCoberto * 100) / 100;
            fObj.teorico_pct = (fatFilCoberto > 0)
              ? Math.round(fObj.teorico_total / fatFilCoberto * 10000) / 100
              : null;
            fObj.sem_ficha_pct = (fatFil > 0)
              ? Math.round((fObj.sem_ficha_valor || 0) / fatFil * 10000) / 100
              : null;
            fObj.sem_ficha_menu_pct = (fatFil > 0)
              ? Math.round((fObj.sem_ficha_valor_menu || 0) / fatFil * 10000) / 100
              : null;
            fObj.sem_ficha_cadastro_pct = (fatFil > 0)
              ? Math.round((fObj.sem_ficha_valor_cadastro || 0) / fatFil * 10000) / 100
              : null;
            if (cmv[m] && cmv[m].filiais && cmv[m].filiais[fil]) {
              fObj.real_total = cmv[m].filiais[fil].cmv;
              fObj.real_pct   = cmv[m].filiais[fil].cmv_pct;
              fObj.diferenca  = Math.round((cmv[m].filiais[fil].cmv - fObj.teorico_total) * 100) / 100;
            }
          });
        }
      }
    });

    return JSON.stringify({
      ok:              true,
      cmc:             cmc,
      cmv:             cmv,
      vendas:          vendas,
      meses:           meses,
      cmvTeorico:      cmvTeorico,
      demandaInsumos:  demandaInsumos,
      reconciliacaoInsumos: reconciliacaoInsumos,
      fichasDisponivel: Object.keys(fichasMap).length > 0,
      avisosInventario: inventarioConectado.avisos
    });

  } catch (err) {
    Logger.log('getPayload ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Gera uma planilha nova do Google com a lista de itens (produtos) que NÃO
// entraram no CMV por falta de preço -- sem histórico de compra E sem
// ficha técnica, mesmo critério de exclusão usado em processarCMV
// (Dados.js). Agrupa por produto: quantas contagens ele apareceu, em quais
// meses/filiais e a quantidade total contada -- pra decidir quais precisam
// de ficha técnica ou registro de compra. Usa a MESMA leitura de dados que
// getPayload, então reflete exatamente o que está sendo excluído do CMV
// agora, não uma amostra.
function gerarPlanilhaItensSemPreco(senha) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var rowsCompras = lerTodosCSVs('compras');
    var rowsVendas  = lerTodosCSVs('vendas');
    var rowsEstoque = lerTodosCSVs('estoque');
    var rowsFichas  = lerFichaTecnica();
    var fichasMap   = processarFichas(rowsFichas);
    var historicoPorInsumo = preAgregarCustoMedioPorInsumo(rowsCompras);

    var inventarioConectado = gerarLinhasEstoqueDeInventariosSalvos_(rowsEstoque, rowsCompras, rowsVendas, historicoPorInsumo, fichasMap, rowsFichas);
    var rowsEstoqueCompleto = (rowsEstoque && rowsEstoque.length ? rowsEstoque : [[]]).concat(inventarioConectado.linhas);

    var porProduto = {};
    for (var i = 1; i < rowsEstoqueCompleto.length; i++) {
      var r = rowsEstoqueCompleto[i];
      if (!r || r.length < 16) continue;
      if (limpaCelula(r[C_ESTOQUE.tp_movto]) !== ESTOQUE_TIPO_VALIDO) continue;
      var dataInfo = parseDataCompleta(r[C_ESTOQUE.data]);
      if (!dataInfo) continue;
      var qtd = numVal(r[C_ESTOQUE.saldo]);
      if (qtd <= 0) continue;
      var produto = limpaCelula(r[C_ESTOQUE.produto]);
      if (!produto) continue;

      var mesNomeLinha = NOMES_MESES[dataInfo.mes];
      var custoUnit = buscarCustoInsumoComFallback(historicoPorInsumo, produto, mesNomeLinha, dataInfo.ano);
      if (custoUnit === null || custoUnit === undefined) {
        custoUnit = fichasMap ? fichasMap[produto] : undefined;
      }
      if (custoUnit !== null && custoUnit !== undefined) continue; // tem preço -- entrou no cálculo normalmente

      var grupo  = limpaCelula(r[C_ESTOQUE.grupo]);
      var unid   = limpaCelula(r[C_ESTOQUE.unid]);
      var filial = limpaCelula(r[C_ESTOQUE.filial]) || 'OUTRA';

      if (!porProduto[produto]) {
        porProduto[produto] = { produto: produto, grupo: grupo, unid: unid, nContagens: 0, qtdTotal: 0, meses: {}, filiais: {} };
      }
      var p = porProduto[produto];
      p.nContagens++;
      p.qtdTotal += qtd;
      p.meses[mesNomeLinha + '/' + dataInfo.ano] = true;
      p.filiais[filial] = true;
      if (!p.grupo && grupo) p.grupo = grupo;
      if (!p.unid && unid) p.unid = unid;
    }

    // Itens excluídos no caminho do conector (Ajustes > Inventário, meses
    // sem CSV) NUNCA viram linha em rowsEstoqueCompleto -- o scan acima não
    // os alcança. Junta aqui pelo mesmo produto, pra não duplicar quem
    // também aparece no CSV real.
    (inventarioConectado.semPreco || []).forEach(function(sp) {
      if (!porProduto[sp.produto]) {
        porProduto[sp.produto] = { produto: sp.produto, grupo: '', unid: sp.und || '', nContagens: 0, qtdTotal: 0, meses: {}, filiais: {} };
      }
      var p = porProduto[sp.produto];
      p.nContagens++;
      p.qtdTotal += (sp.qtd || 0);
      if (sp.mes && sp.ano) p.meses[sp.mes + '/' + sp.ano] = true;
      if (sp.unidade) p.filiais[sp.unidade] = true;
      if (!p.unid && sp.und) p.unid = sp.und;
    });

    var lista = Object.keys(porProduto).map(function(k) {
      var p = porProduto[k];
      return [
        p.produto, p.grupo, p.unid, p.nContagens, r2(p.qtdTotal),
        Object.keys(p.meses).sort().join(', '),
        Object.keys(p.filiais).sort().join(', ')
      ];
    }).sort(function(a, b) { return b[3] - a[3]; }); // mais contagens primeiro

    var nomePlanilha = 'Itens sem preço - CMV - ' + Utilities.formatDate(new Date(), 'America/Fortaleza', 'dd-MM-yyyy HH:mm');
    var ss = SpreadsheetApp.create(nomePlanilha);
    var aba = ss.getSheets()[0];
    aba.setName('Itens sem preço');
    var header = ['Produto', 'Grupo', 'Unidade', 'Nº de Contagens', 'Qtd. Total Contada', 'Meses', 'Filiais'];
    aba.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (lista.length) {
      aba.getRange(2, 1, lista.length, header.length).setValues(lista);
    }
    aba.autoResizeColumns(1, header.length);
    aba.setFrozenRows(1);

    Logger.log('Planilha de itens sem preco criada: ' + ss.getUrl() + ' (' + lista.length + ' produtos)');
    return JSON.stringify({ ok: true, url: ss.getUrl(), total: lista.length });
  } catch (err) {
    Logger.log('gerarPlanilhaItensSemPreco ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// ── LEITURA DE CSVs ──────────────────────────────────────────

// Lê TODOS os CSVs do tipo na pasta e combina as linhas.
// O cabeçalho é lido do primeiro arquivo encontrado;
// os demais arquivos têm o cabeçalho ignorado para não duplicar.
function lerTodosCSVs(tipo) {
  var pasta  = DriveApp.getFolderById(PASTA_ID);
  var files  = pasta.getFiles();
  var padrao = PADROES[tipo];

  var encontrados = [];
  while (files.hasNext()) {
    var f = files.next();
    var nome = f.getName();
    if (!nome.toLowerCase().endsWith('.csv')) continue;
    if (!padrao.test(nome)) continue;
    encontrados.push(f);
  }

  if (encontrados.length === 0) {
    throw new Error(
      'Nenhum CSV de "' + tipo + '" encontrado na pasta. ' +
      'O nome do arquivo deve conter "' + tipo + '" (ex: compras_janeiro.csv).'
    );
  }

  // Ordenar por nome para processar em ordem cronológica
  encontrados.sort(function(a, b) {
    return a.getName().localeCompare(b.getName());
  });

  Logger.log('Arquivos de ' + tipo + ' (' + encontrados.length + '):');
  encontrados.forEach(function(f) { Logger.log('  ' + f.getName()); });

  var todasLinhas = null;

  encontrados.forEach(function(f) {
    var conteudo;
    try {
      conteudo = f.getBlob().getDataAsString('UTF-8');
    } catch(enc) {
      conteudo = f.getBlob().getDataAsString('ISO-8859-1');
    }
    var linhas = Utilities.parseCsv(conteudo, '\t');
    if (!linhas || linhas.length < 2) return;

    if (todasLinhas === null) {
      // Primeiro arquivo — incluir cabeçalho
      todasLinhas = linhas;
    } else {
      // Demais arquivos — pular linha 0 (cabeçalho) e concatenar
      todasLinhas = todasLinhas.concat(linhas.slice(1));
    }
  });

  if (!todasLinhas || todasLinhas.length < 2) {
    throw new Error('CSVs de "' + tipo + '" encontrados mas sem dados válidos.');
  }

  Logger.log('Total de linhas combinadas (' + tipo + '): ' + (todasLinhas.length - 1));
  return todasLinhas;
}

// Lê o arquivo de ficha técnica mais recente na pasta (nome começa com "fichas").
// Diferente de compras/vendas/estoque, ficha técnica NÃO acumula por mês —
// é uma foto do momento do envio, então só lemos o arquivo mais recente,
// sem concatenar. Retorna [] se ainda não houver nenhuma (recurso opcional).
// Lê só o arquivo exportado do Cloudfy (mais recente cujo nome bate
// PADROES.fichas) -- NUNCA chamar direto fora de lerFichaTecnica() (abaixo),
// que já aplica as fichas cadastradas/editadas manualmente por cima.
function lerFichaTecnicaCloudfy_() {
  var pasta = DriveApp.getFolderById(PASTA_ID);
  var files = pasta.getFiles();
  var maisRecente = null;

  while (files.hasNext()) {
    var f = files.next();
    var nome = f.getName();
    if (!nome.toLowerCase().endsWith('.csv')) continue;
    if (!PADROES.fichas.test(nome)) continue;
    if (!maisRecente || f.getLastUpdated() > maisRecente.getLastUpdated()) {
      maisRecente = f;
    }
  }

  if (!maisRecente) {
    Logger.log('Nenhum arquivo de ficha técnica encontrado. CMV Teórico não calculado.');
    return [];
  }

  var conteudo;
  try {
    conteudo = maisRecente.getBlob().getDataAsString('UTF-8');
  } catch (enc) {
    conteudo = maisRecente.getBlob().getDataAsString('ISO-8859-1');
  }
  var linhas = Utilities.parseCsv(conteudo, '\t');
  Logger.log('Ficha técnica lida: ' + maisRecente.getName() + ' (' + (linhas.length - 1) + ' linhas)');
  return linhas;
}

// Ponto único de leitura de ficha técnica pro resto do sistema: linhas do
// Cloudfy (lerFichaTecnicaCloudfy_) com as fichas cadastradas/editadas
// manualmente (Fichas.html, planilha FICHAS_MANUAIS_SHEET_ID) sobrepostas
// por cima -- ver montarRowsFichasCompleto_ pra regra de sobrescrita.
// Trocar lerFichaTecnicaCloudfy_() aqui por esta função em todo o resto do
// código faz TODOS os cálculos (CMV Teórico, Demanda de Insumos, conector
// de inventário) já refletirem as fichas manuais automaticamente.
function lerFichaTecnica() {
  return montarRowsFichasCompleto_(lerFichaTecnicaCloudfy_());
}

// ── FICHAS TÉCNICAS MANUAIS (cadastro/edição mobile, Fichas.html) ──
//
// Planilha separada (mesmo padrão de CONTAGEM_SHEET_ID) com uma aba
// "FICHAS": PRODUTO | TIPO | RENDIMENTO | INSUMO_NOME | INSUMO_QTDE |
// INSUMO_UND — uma linha por insumo, igual ao TSV do Cloudfy, mas SEM
// coluna de custo (o sistema nunca usa o custo digitado numa ficha como
// fonte principal — ver buscarCustoInsumoComFallback/calcularCustoExplodido
// em Dados.js; preço sempre vem do histórico real de compra). O ID da
// planilha é provisionado sozinho no primeiro uso (Script Properties),
// sem precisar de nenhuma configuração manual.
var C_FICHAS_MANUAIS = { produto: 0, tipo: 1, rendimento: 2, insumo_nome: 3, insumo_qtde: 4, insumo_und: 5 };

function obterFichasManuaisSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('FICHAS_MANUAIS_SHEET_ID');
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('Fichas Técnicas Manuais - Amazônia na Cuia');
    var aba = ss.getSheets()[0];
    aba.setName('FICHAS');
    aba.getRange(1, 1, 1, 6).setValues([['PRODUTO', 'TIPO', 'RENDIMENTO', 'INSUMO_NOME', 'INSUMO_QTDE', 'INSUMO_UND']]);
    aba.setFrozenRows(1);
    props.setProperty('FICHAS_MANUAIS_SHEET_ID', ss.getId());
    Logger.log('Planilha de fichas manuais criada: ' + ss.getUrl());
  }
  if (!ss.getSheetByName('HISTORICO')) {
    var abaHist = ss.insertSheet('HISTORICO');
    abaHist.getRange(1, 1, 1, 5).setValues([['DATA/HORA', 'PRODUTO', 'AÇÃO', 'RESPONSÁVEL', 'DETALHE']]);
    abaHist.setFrozenRows(1);
  }
  return ss;
}

// Registra uma linha no histórico (mais recente sempre no TOPO, logo
// abaixo do cabeçalho, pra facilitar leitura sem precisar ordenar).
function registrarHistoricoFicha_(ss, produto, acao, responsavel, detalhe) {
  var abaHist = ss.getSheetByName('HISTORICO');
  var agora = Utilities.formatDate(new Date(), 'America/Fortaleza', 'dd/MM/yyyy HH:mm');
  abaHist.insertRowAfter(1);
  abaHist.getRange(2, 1, 1, 5).setValues([[agora, produto, acao, String(responsavel || '').trim() || '(não informado)', detalhe || '']]);
}

// Lê a planilha de fichas manuais e devolve { linhas, produtosComOverride }
// -- linhas já no formato array-de-C_FICHAS (Dados.js), prontas pra
// concatenar com as linhas do Cloudfy; produtosComOverride é um mapa
// {NOME_UPPER: true} usado pra filtrar as linhas do Cloudfy desse produto.
function lerFichasManuais_() {
  var ss = obterFichasManuaisSheet_();
  var aba = ss.getSheetByName('FICHAS');
  var dados = aba.getDataRange().getValues();
  var linhas = [];
  var produtosComOverride = {};
  for (var i = 1; i < dados.length; i++) {
    var r = dados[i];
    var produto = String(r[C_FICHAS_MANUAIS.produto] || '').trim();
    if (!produto) continue;
    produtosComOverride[produto.toUpperCase()] = true;

    var linha = new Array(16).fill('');
    linha[C_FICHAS.produto]     = produto;
    linha[C_FICHAS.tipo]        = String(r[C_FICHAS_MANUAIS.tipo] || '').trim();
    linha[C_FICHAS.rendimento]  = r[C_FICHAS_MANUAIS.rendimento];
    linha[C_FICHAS.insumo_nome] = String(r[C_FICHAS_MANUAIS.insumo_nome] || '').trim();
    linha[C_FICHAS.insumo_qtde] = r[C_FICHAS_MANUAIS.insumo_qtde];
    linha[C_FICHAS.insumo_und]  = String(r[C_FICHAS_MANUAIS.insumo_und] || '').trim();
    linhas.push(linha);
  }
  return { linhas: linhas, produtosComOverride: produtosComOverride };
}

// Junta as linhas do Cloudfy com as fichas manuais, aplicando a regra de
// sobrescrita: se um produto tem ficha manual, TODAS as linhas dele vindas
// do Cloudfy são descartadas antes de concatenar -- senão
// processarReceitas (Dados.js) acumularia os insumos antigos do Cloudfy
// junto com os novos da edição manual, misturando as duas receitas.
// Preserva uma linha 0 (cabeçalho, nunca lida) pra manter o formato que
// processarFichas/processarReceitas esperam (loop começa em i=1).
function montarRowsFichasCompleto_(rowsFichasCloudfy) {
  var manual = lerFichasManuais_();
  var overrideSet = manual.produtosComOverride;
  var cloudfyFiltrado = (rowsFichasCloudfy || []).slice(1).filter(function(r) {
    if (!r) return false;
    var produto = limpaCelula(r[C_FICHAS.produto]);
    return !overrideSet[produto.toUpperCase()];
  });
  return [[]].concat(manual.linhas).concat(cloudfyFiltrado);
}

// Senha separada da senha do painel CMV (SENHA_ACESSO) -- ficha técnica é
// operacional, pode ser usada por qualquer pessoa da equipe, não só quem
// vê dado financeiro. Configurar em Project Settings > Script Properties,
// chave "SENHA_FICHAS".
function validarSenhaFichas(senha) {
  var senhaConfigurada = PropertiesService.getScriptProperties().getProperty('SENHA_FICHAS');
  if (!senhaConfigurada) {
    Logger.log('SENHA_FICHAS nao configurada em Script Properties.');
    return false;
  }
  return String(senha) === senhaConfigurada;
}

// Lista de nomes conhecidos pro autocomplete de insumo/produto: união do
// catálogo de Compras+Vendas com os produtos que já têm ficha manual
// (permite apontar um insumo pra outro preparo manual, criando receita
// aninhada -- ver explodirInsumos/calcularCustoExplodido em Dados.js, que
// casam por nome exato contra o mapa "receitas" final, sem distinguir origem).
function listarCatalogoInsumos(senhaFichas) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var rowsCompras = lerTodosCSVs('compras');
    var rowsVendas  = lerTodosCSVs('vendas');
    var catalogo = preAgregarCatalogoProdutos(rowsCompras, rowsVendas);
    var manual = lerFichasManuais_();
    var nomes = {};
    Object.keys(catalogo).forEach(function(k) { nomes[catalogo[k].nome] = true; });
    Object.keys(manual.produtosComOverride).forEach(function(p) { nomes[p] = true; });
    var lista = Object.keys(nomes).sort();

    // Unidade de medida padrão de cada insumo (a que já vem cadastrada em
    // Compras) -- pro app preencher sozinho o campo "Und." ao escolher um
    // insumo já conhecido, sem o usuário ter que digitar de novo.
    var unidades = {};
    if (rowsCompras && rowsCompras.length > 1) {
      for (var i = 1; i < rowsCompras.length; i++) {
        var r = rowsCompras[i];
        if (!r || r.length < 18) continue;
        var produto = limpaCelula(r[C_COMPRAS.produto]);
        var unid = limpaCelula(r[C_COMPRAS.unid]);
        if (produto && unid && !unidades[produto.toUpperCase()]) unidades[produto.toUpperCase()] = unid;
      }
    }
    // Insumos já cadastrados manualmente também carregam sua própria
    // unidade (a que foi digitada da última vez que essa ficha foi salva).
    manual.linhas.forEach(function(l) {
      var nomeIns = String(l[C_FICHAS.insumo_nome] || '').trim();
      var undIns = String(l[C_FICHAS.insumo_und] || '').trim();
      if (nomeIns && undIns && !unidades[nomeIns.toUpperCase()]) unidades[nomeIns.toUpperCase()] = undIns;
    });

    return JSON.stringify({ ok: true, produtos: lista, unidades: unidades });
  } catch (err) {
    Logger.log('listarCatalogoInsumos ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Devolve a ficha EFETIVA de um produto (manual se existir, senão a do
// Cloudfy) pronta pra abrir na tela de edição -- mesma fonte de verdade
// (montarRowsFichasCompleto_) usada pelo resto do sistema, então o que
// aparece pra editar é exatamente o que está valendo no cálculo agora.
function buscarFicha(senhaFichas, produto) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var produtoUpper = String(produto || '').trim().toUpperCase();
    if (!produtoUpper) return JSON.stringify({ ok: true, existe: false });

    var rowsCompleto = montarRowsFichasCompleto_(lerFichaTecnicaCloudfy_());
    var receitas = processarReceitas(rowsCompleto);
    var chave = Object.keys(receitas).filter(function(k) { return k.trim().toUpperCase() === produtoUpper; })[0];
    if (!chave) return JSON.stringify({ ok: true, existe: false });

    var r = receitas[chave];
    var manual = lerFichasManuais_();
    return JSON.stringify({
      ok: true, existe: true, produto: chave, tipo: r.tipo, rendimento: r.rendimento,
      insumos: r.insumos.map(function(i) { return { nome: i.nome, qtd: i.qtde, und: i.und }; }),
      origem: manual.produtosComOverride[produtoUpper] ? 'manual' : 'cloudfy'
    });
  } catch (err) {
    Logger.log('buscarFicha ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Lista/busca fichas cadastradas (Cloudfy + manuais), pra tela de busca do
// app de fichas.
function listarFichasCadastradas(senhaFichas, busca) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var rowsCompleto = montarRowsFichasCompleto_(lerFichaTecnicaCloudfy_());
    var receitas = processarReceitas(rowsCompleto);
    var manual = lerFichasManuais_();
    var termo = String(busca || '').trim().toUpperCase();
    var lista = Object.keys(receitas).filter(function(p) {
      return !termo || p.toUpperCase().indexOf(termo) >= 0;
    }).map(function(p) {
      return {
        produto: p, tipo: receitas[p].tipo, rendimento: receitas[p].rendimento,
        nInsumos: receitas[p].insumos.length,
        origem: manual.produtosComOverride[p.toUpperCase()] ? 'manual' : 'cloudfy'
      };
    }).sort(function(a, b) { return a.produto.localeCompare(b.produto); });
    return JSON.stringify({ ok: true, fichas: lista });
  } catch (err) {
    Logger.log('listarFichasCadastradas ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Salva (cria ou substitui por completo) a ficha manual de um produto --
// nunca faz diff parcial de linha: apaga tudo que já existia desse
// produto na planilha e escreve o conjunto novo inteiro, o que evita
// linha órfã de insumo removido no formulário. Registra no histórico se
// foi cadastro novo ou edição de uma já existente.
// dados: { produto, tipo, rendimento, insumos:[{nome, qtd, und}], responsavel }
function salvarFicha(senhaFichas, dados) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    if (!dados || !String(dados.produto || '').trim()) {
      return JSON.stringify({ ok: false, erro: 'Informe o nome do produto.' });
    }
    if (!dados.tipo) {
      return JSON.stringify({ ok: false, erro: 'Informe o tipo (Venda ou Matéria prima).' });
    }
    var rendimento = numVal(dados.rendimento);
    if (!rendimento || rendimento <= 0) {
      return JSON.stringify({ ok: false, erro: 'Informe o rendimento (quantas unidades uma receita/lote produz).' });
    }
    var insumos = (dados.insumos || []).filter(function(i) { return i && String(i.nome || '').trim() && numVal(i.qtd) > 0; });
    if (!insumos.length) {
      return JSON.stringify({ ok: false, erro: 'Adicione pelo menos um insumo com quantidade.' });
    }

    var produto = String(dados.produto).trim().toUpperCase();
    var ss = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName('FICHAS');
    var valores = aba.getDataRange().getValues();
    var jaExistia = false;
    for (var i = valores.length - 1; i >= 1; i--) {
      if (String(valores[i][C_FICHAS_MANUAIS.produto] || '').trim().toUpperCase() === produto) {
        jaExistia = true;
        aba.deleteRow(i + 1);
      }
    }

    var novasLinhas = insumos.map(function(ins) {
      return [produto, dados.tipo, rendimento, String(ins.nome).trim().toUpperCase(), numVal(ins.qtd), String(ins.und || '').trim()];
    });
    aba.getRange(aba.getLastRow() + 1, 1, novasLinhas.length, 6).setValues(novasLinhas);

    registrarHistoricoFicha_(ss, produto, jaExistia ? 'Editada' : 'Cadastrada', dados.responsavel,
      dados.tipo + ' · rendimento ' + rendimento + ' · ' + novasLinhas.length + ' insumo(s)');

    Logger.log('Ficha manual salva: ' + produto + ' (' + novasLinhas.length + ' insumo(s)).');
    return JSON.stringify({ ok: true });
  } catch (err) {
    Logger.log('salvarFicha ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Remove o override manual de um produto -- volta a valer a versão do
// Cloudfy pra esse produto, se existir uma.
function excluirFichaManual(senhaFichas, produto, responsavel) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var produtoUpper = String(produto || '').trim().toUpperCase();
    var ss = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName('FICHAS');
    var valores = aba.getDataRange().getValues();
    var removidas = 0;
    for (var i = valores.length - 1; i >= 1; i--) {
      if (String(valores[i][C_FICHAS_MANUAIS.produto] || '').trim().toUpperCase() === produtoUpper) {
        aba.deleteRow(i + 1);
        removidas++;
      }
    }
    if (removidas > 0) {
      registrarHistoricoFicha_(ss, produtoUpper, 'Edição removida (voltou pro Cloudfy)', responsavel, '');
    }
    return JSON.stringify({ ok: true, removidas: removidas });
  } catch (err) {
    Logger.log('excluirFichaManual ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Lista o histórico de cadastro/edição de fichas manuais, mais recente
// primeiro (a aba HISTORICO já é escrita nessa ordem -- ver
// registrarHistoricoFicha_). "limite" opcional corta a lista (padrão 300,
// suficiente pra uso normal sem carregar a planilha inteira sempre).
function listarHistoricoFichas(senhaFichas, limite) {
  if (!validarSenhaFichas(senhaFichas)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var ss = obterFichasManuaisSheet_();
    var aba = ss.getSheetByName('HISTORICO');
    var max = Number(limite) > 0 ? Number(limite) : 300;
    var ultimaLinha = aba.getLastRow();
    if (ultimaLinha < 2) return JSON.stringify({ ok: true, historico: [] });

    var nLinhas = Math.min(max, ultimaLinha - 1);
    var valores = aba.getRange(2, 1, nLinhas, 5).getValues();
    var historico = valores.map(function(r) {
      return { data: r[0], produto: r[1], acao: r[2], responsavel: r[3], detalhe: r[4] };
    });
    return JSON.stringify({ ok: true, historico: historico });
  } catch (err) {
    Logger.log('listarHistoricoFichas ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// ── INTEGRAÇÃO COM O SISTEMA DE CONTAGEM/ESTOQUE (projeto Apps Script separado) ──
var CONTAGEM_SHEET_ID = '15NWs6IiDMJEOYaiDWPzSSAtHsJoziSpkwaz2yjgkppU';

// Lista as contagens registradas no sistema de contagem (aba CONTAGENS),
// pra unidade escolhida — usado na tela de Ajustes > Inventário, pra o
// usuário escolher manualmente quais contagens representam o inventário de
// uma semana (a operação real não segue um padrão fixo de dia/turno, então
// a escolha é manual em vez de tentar adivinhar por data).
function listarContagensDisponiveis(senha, unidade) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var ss  = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
    var aba = ss.getSheetByName('CONTAGENS');
    if (!aba) return JSON.stringify({ ok: false, erro: 'Aba CONTAGENS não encontrada na planilha.' });

    var rows = aba.getDataRange().getValues();
    var lista = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (!r[0]) continue;
      var uni = String(r[2]).trim();
      if (unidade && uni !== unidade) continue;
      lista.push({
        id: String(r[0]).trim(),
        data: String(r[1]).trim(),
        unidade: uni,
        setor: String(r[3]).trim(),
        turno: String(r[4]).trim(),
        responsavel: String(r[5]).trim(),
        status: String(r[6]).trim(),
        dataFechamento: String(r[7] || '').trim()
      });
    }
    lista.sort(function(a, b) { return b.data.localeCompare(a.data); });
    return JSON.stringify({ ok: true, contagens: lista });
  } catch (err) {
    Logger.log('listarContagensDisponiveis ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

function obterInventariosSalvos_() {
  var valor = PropertiesService.getScriptProperties().getProperty('INVENTARIOS_SEMANAIS_SALVOS');
  return valor ? JSON.parse(valor) : [];
}

// Lista as seleções de inventário semanal já salvas (Script Properties).
function listarInventariosSalvos(senha) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var lista = obterInventariosSalvos_();
    return JSON.stringify({ ok: true, inventarios: lista });
  } catch (err) {
    Logger.log('listarInventariosSalvos ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Salva (cria ou atualiza, se "id" já existir) uma seleção de inventário
// semanal: um nome (label), a unidade, e a lista de IDs de contagem
// escolhidos manualmente como representando o inventário daquela semana.
function salvarInventarioSemanal(senha, dados) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    if (!dados || !dados.label || !dados.unidade || !dados.contagemIds || !dados.contagemIds.length) {
      return JSON.stringify({ ok: false, erro: 'Informe um nome, a unidade e pelo menos uma contagem selecionada.' });
    }
    var props = PropertiesService.getScriptProperties();
    var valor = props.getProperty('INVENTARIOS_SEMANAIS_SALVOS');
    var lista = valor ? JSON.parse(valor) : [];

    var novo = {
      id: dados.id || ('INV-' + new Date().getTime()),
      label: String(dados.label).trim(),
      unidade: String(dados.unidade).trim(),
      contagemIds: dados.contagemIds
    };

    var idx = -1;
    for (var i = 0; i < lista.length; i++) { if (lista[i].id === novo.id) { idx = i; break; } }
    if (idx >= 0) lista[idx] = novo; else lista.push(novo);

    props.setProperty('INVENTARIOS_SEMANAIS_SALVOS', JSON.stringify(lista));
    Logger.log('Inventario semanal salvo: ' + novo.label + ' (' + novo.unidade + ', ' + novo.contagemIds.length + ' contagens)');
    return JSON.stringify({ ok: true, inventario: novo, inventarios: lista });
  } catch (err) {
    Logger.log('salvarInventarioSemanal ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Exclui uma seleção de inventário semanal salva.
function excluirInventarioSemanal(senha, id) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var valor = props.getProperty('INVENTARIOS_SEMANAIS_SALVOS');
    var lista = valor ? JSON.parse(valor) : [];
    var nova = lista.filter(function(x) { return x.id !== id; });
    props.setProperty('INVENTARIOS_SEMANAIS_SALVOS', JSON.stringify(nova));
    Logger.log('Inventario semanal excluido: ' + id);
    return JSON.stringify({ ok: true, inventarios: nova });
  } catch (err) {
    Logger.log('excluirInventarioSemanal ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// ── SEMANAS DO MÊS (CMV/CMC semanal e quinzenal, ancorados em contagem real) ──
//
// Uma "semana salva" liga DOIS inventários já salvos (Ajustes > Inventário)
// como o inicial e o final de uma semana (1 a 4) de um mês, pra UMA unidade.
// O cálculo em si (calcularAnaliseSemanal) usa isso pra precificar EI/EF e
// somar compras/vendas do intervalo real de dias entre as duas contagens —
// nunca um calendário fixo (1-7, 8-14...), sempre a data de verdade das
// contagens escolhidas.
function listarSemanasSalvas(senha, mes, ano) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var lista = obterSemanasSalvas_();
    if (mes) lista = lista.filter(function(s) { return s.mes === mes && (!ano || s.ano === Number(ano)); });
    return JSON.stringify({ ok: true, semanas: lista });
  } catch (err) {
    Logger.log('listarSemanasSalvas ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

function obterSemanasSalvas_() {
  var valor = PropertiesService.getScriptProperties().getProperty('SEMANAS_SALVAS_CMV');
  return valor ? JSON.parse(valor) : [];
}

// Salva (cria ou atualiza, se "id" já existir) qual par de inventários
// marca o início/fim de UMA semana (1-4) de um mês, pra uma unidade.
// Valida que os dois inventários existem e que a data resolvida de ambos
// cai dentro do mês/ano informado — evita salvar uma semana com contagem
// de outro mês por engano.
function salvarSemana(senha, dados) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    if (!dados || !dados.mes || !dados.ano || !dados.semanaNum || !dados.unidade ||
        !dados.inventarioInicialId || !dados.inventarioFinalId) {
      return JSON.stringify({ ok: false, erro: 'Informe mês, ano, número da semana, unidade e os dois inventários (inicial e final).' });
    }
    if ([1, 2, 3, 4].indexOf(Number(dados.semanaNum)) < 0) {
      return JSON.stringify({ ok: false, erro: 'Número da semana inválido (use 1, 2, 3 ou 4).' });
    }

    var inventarios = obterInventariosSalvos_();
    var invInicial = inventarios.filter(function(i) { return i.id === dados.inventarioInicialId; })[0];
    var invFinal   = inventarios.filter(function(i) { return i.id === dados.inventarioFinalId; })[0];
    if (!invInicial || !invFinal) {
      return JSON.stringify({ ok: false, erro: 'Inventário inicial ou final não encontrado — pode ter sido excluído.' });
    }

    var dataPorContagemId = lerDataPorContagemId_();
    var infoInicial = resolverDataInventario_(invInicial, dataPorContagemId);
    var infoFinal   = resolverDataInventario_(invFinal, dataPorContagemId);
    if (!infoInicial || !infoFinal) {
      return JSON.stringify({ ok: false, erro: 'Não foi possível encontrar a data de um dos inventários escolhidos.' });
    }
    // O FIM sempre tem que cair no mês/ano da semana (é o que "fecha" essa
    // semana). Já o INÍCIO pode ser do mês anterior — uma contagem feita no
    // dia 31 (ou 1º) vira o fim de uma semana e o início da próxima, e essas
    // duas datas podem estar em meses diferentes (ex: fecha Semana 4 de
    // Agosto E abre a Semana 1 de Setembro). Por isso só o início aceita o
    // mês anterior; o fim nunca.
    var mesNumAlvo = Number(Object.keys(NOMES_MESES).filter(function(k) { return NOMES_MESES[k] === dados.mes; })[0]);
    var anoAlvo = Number(dados.ano);
    var mesAnteriorNum = mesNumAlvo === 1 ? 12 : mesNumAlvo - 1;
    var anoAnteriorNum = mesNumAlvo === 1 ? anoAlvo - 1 : anoAlvo;

    if (NOMES_MESES[infoFinal.mes] !== dados.mes || infoFinal.ano !== anoAlvo) {
      return JSON.stringify({ ok: false, erro: 'O inventário final precisa ser de ' + dados.mes + '/' + dados.ano + '. Escolha um inventário desse mês.' });
    }
    var inicialNoMesAlvo = infoInicial.mes === mesNumAlvo && infoInicial.ano === anoAlvo;
    var inicialNoMesAnterior = infoInicial.mes === mesAnteriorNum && infoInicial.ano === anoAnteriorNum;
    if (!inicialNoMesAlvo && !inicialNoMesAnterior) {
      return JSON.stringify({ ok: false, erro: 'O inventário inicial precisa ser de ' + dados.mes + '/' + dados.ano + ' ou do mês anterior (' + NOMES_MESES[mesAnteriorNum] + '/' + anoAnteriorNum + ').' });
    }
    if (infoFinal.ts < infoInicial.ts) {
      return JSON.stringify({ ok: false, erro: 'O inventário final é de uma data anterior ao inicial — confira a ordem.' });
    }

    var props = PropertiesService.getScriptProperties();
    var lista = obterSemanasSalvas_();
    var novo = {
      id: dados.id || ('SEM-' + new Date().getTime()),
      mes: dados.mes, ano: Number(dados.ano), semanaNum: Number(dados.semanaNum),
      unidade: String(dados.unidade).trim(),
      inventarioInicialId: dados.inventarioInicialId,
      inventarioFinalId: dados.inventarioFinalId
    };

    var idx = -1;
    for (var i = 0; i < lista.length; i++) { if (lista[i].id === novo.id) { idx = i; break; } }
    if (idx >= 0) lista[idx] = novo; else lista.push(novo);

    props.setProperty('SEMANAS_SALVAS_CMV', JSON.stringify(lista));
    Logger.log('Semana salva: ' + novo.mes + '/' + novo.ano + ' Semana ' + novo.semanaNum + ' (' + novo.unidade + ')');
    return JSON.stringify({ ok: true, semana: novo, semanas: lista });
  } catch (err) {
    Logger.log('salvarSemana ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

function excluirSemana(senha, id) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var lista = obterSemanasSalvas_();
    var nova = lista.filter(function(x) { return x.id !== id; });
    props.setProperty('SEMANAS_SALVAS_CMV', JSON.stringify(nova));
    Logger.log('Semana excluida: ' + id);
    return JSON.stringify({ ok: true, semanas: nova });
  } catch (err) {
    Logger.log('excluirSemana ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Calcula CMC/CMV de cada Semana salva (1-4) de um mês/ano, mais as duas
// quinzenas reais (1ª = Semana 1+2, 2ª = Semana 3+4 — só aparece quando as
// duas semanas da quinzena estiverem salvas pra mesma unidade). Nunca usa
// calendário fixo (dia 1-7, 8-14...): o início/fim de cada período é a data
// de verdade das contagens escolhidas em Ajustes > Inventário > Semanas.
//
// Endpoint sob demanda — só roda quando o usuário escolhe uma Semana/
// Quinzena em Análise Mês a Mês ou CMV, não faz parte do getPayload
// principal (evita deixar o
// login mais lento com uma leitura da planilha de contagem que a maioria
// das cargas de página não precisa).
// Monta o CMV detalhado (por grupo/produto) de UMA unidade, pra um periodo
// (semana ou quinzena) do CMV por Semana/Quinzena -- mesmo formato de
// cmv[mes].filiais[unidade] (Dados.js/processarCMV), so que o EI/EF vem do
// inventario salvo (valorizarItensInventario_.porProduto) em vez das
// contagens de estoque do CSV. Reaproveita o mesmo motor de compras/
// transferencia (comprasPeriodoCMV_) e a mesma montagem de grupos
// (montarGruposCMV_) do CMV mensal -- garante que os dois nunca divergem.
function montarCMVDetalhadoUnidade_(eiPorProduto, efPorProduto, rowsCompras, mesIniNum, anoIni, diaInicio, mesFimNum, anoFim, diaFim, unidade) {
  function agruparPorGrupo(itens) {
    var porGrupo = {}, porProdGrupo = {}, porProdGrupoQtd = {}, porProdGrupoFontes = {};
    (itens || []).forEach(function(item) {
      var g = item.grupo || '';
      var p = item.produto || '';
      var v = item.custoTotal || 0;
      if (!g) return;
      porGrupo[g] = (porGrupo[g] || 0) + v;
      if (p) {
        if (!porProdGrupo[g]) porProdGrupo[g] = {};
        porProdGrupo[g][p] = (porProdGrupo[g][p] || 0) + v;
        // Quantidade em estoque do produto (qtd contada) — usada na tabela
        // "Produtos do Grupo" quando exibida "Por quantidade".
        if (!porProdGrupoQtd[g]) porProdGrupoQtd[g] = {};
        porProdGrupoQtd[g][p] = (porProdGrupoQtd[g][p] || 0) + (item.qtd || 0);
        // Contagem(ns) de origem deste produto — permite corrigir o valor
        // direto da aba CMV (ver abrirCorrecaoDeItem/abrirCorrigirItemFonte).
        if (!porProdGrupoFontes[g]) porProdGrupoFontes[g] = {};
        porProdGrupoFontes[g][p] = (porProdGrupoFontes[g][p] || []).concat(item.fontes || []);
      }
    });
    return { porGrupo: porGrupo, porProdGrupo: porProdGrupo, porProdGrupoQtd: porProdGrupoQtd, porProdGrupoFontes: porProdGrupoFontes };
  }

  var ei = agruparPorGrupo(eiPorProduto);
  var ef = agruparPorGrupo(efPorProduto);
  var eiF = (eiPorProduto || []).reduce(function(s, i) { return s + (i.custoTotal || 0); }, 0);
  var efF = (efPorProduto || []).reduce(function(s, i) { return s + (i.custoTotal || 0); }, 0);

  var cMes = comprasPeriodoCMVCross_(rowsCompras, mesIniNum, anoIni, diaInicio, mesFimNum, anoFim, diaFim);
  var filC = (cMes.filiais && cMes.filiais[unidade]) || { total: 0, grupos: {}, prodGrupo: {} };

  var grupos = montarGruposCMV_(
    ei.porGrupo, ei.porProdGrupo, ef.porGrupo, ef.porProdGrupo,
    filC.grupos || {}, filC.prodGrupo || {},
    (cMes.entradaFilialGrupo && cMes.entradaFilialGrupo[unidade]) || {},
    (cMes.saidaFilialGrupo   && cMes.saidaFilialGrupo[unidade])   || {},
    (cMes.entradaProdGrupoFilial && cMes.entradaProdGrupoFilial[unidade]) || {},
    (cMes.saidaProdGrupoFilial   && cMes.saidaProdGrupoFilial[unidade])   || {},
    ei.porProdGrupoQtd, ef.porProdGrupoQtd,
    ei.porProdGrupoFontes, ef.porProdGrupoFontes
  );

  var coF = filC.total || 0;  // ja inclui entrada de transferencia
  var entradaTransf = (cMes.entradaFilial && cMes.entradaFilial[unidade]) || 0;
  var saidaTransf   = (cMes.saidaFilial   && cMes.saidaFilial[unidade])   || 0;
  var comprasAjust = coF - saidaTransf;
  var cmvSemAjuste = eiF + coF - efF;
  var comprasPuro = coF - entradaTransf;
  var cmvPuro = eiF + comprasPuro - efF;

  return {
    ei: r2(eiF), ef: r2(efF), compras: r2(comprasAjust),
    cmv: r2(eiF + comprasAjust - efF), cmv_pct: null, faturamento: 0,
    cmv_sem_ajuste: r2(cmvSemAjuste),
    compras_puro: r2(comprasPuro),
    cmv_puro: r2(cmvPuro),
    transf_entrada: r2(entradaTransf),
    transf_saida:   r2(saidaTransf),
    transf_saldo:   r2(entradaTransf - saidaTransf),
    grupos: grupos
  };
}

// Injeta faturamento/percentuais num objeto de CMC de um periodo (mesmo
// formato de cmc[mes], vindo de processarComprasIntervaloDias) -- espelha a
// injecao que getPayload ja faz pro mes inteiro (linha ~108), so que usando
// as vendas do intervalo de dias em vez do mes inteiro.
function injetarFaturamentoCmcPeriodo_(cmcPeriodo, porDiaVendas, mesIniNum, anoIni, diaInicio, mesFimNum, anoFim, diaFim) {
  var vendasPeriodo = somarPeriodoPreAgregadoCross_(porDiaVendas, mesIniNum, anoIni, diaInicio, mesFimNum, anoFim, diaFim);
  var fat = vendasPeriodo.total || 0;
  if (fat > 0) {
    cmcPeriodo.faturamento = r2(fat);
    cmcPeriodo.cmc_pct_fat = cmcPeriodo.cmc_total
      ? Math.round(cmcPeriodo.cmc_total / fat * 10000) / 100
      : null;
  }
  if (cmcPeriodo.filiais) {
    Object.keys(cmcPeriodo.filiais).forEach(function(fil) {
      var fatFil = (vendasPeriodo.filiais && vendasPeriodo.filiais[fil]) || 0;
      var filObj = cmcPeriodo.filiais[fil];
      filObj.faturamento = r2(fatFil);
      filObj.cmc_pct_fat = (fatFil > 0)
        ? Math.round(filObj.cmc_total / fatFil * 10000) / 100
        : null;
      var entradaVal = filObj.transf_entrada || 0;
      filObj.cmc_com_transf = Math.round((filObj.cmc_total + entradaVal) * 100) / 100;
      filObj.cmc_pct_fat_com_transf = (fatFil > 0)
        ? Math.round(filObj.cmc_com_transf / fatFil * 10000) / 100
        : null;
    });
  }
  return cmcPeriodo;
}

function calcularAnaliseSemanal(senha, mes, ano) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var anoNum = Number(ano);
    // Número (1-12) do mês alvo -- o FIM de toda semana/quinzena salva aqui
    // é sempre desse mês (validado em salvarSemana); o início é que pode
    // ser do mês anterior, por isso as somas de período usam as versões
    // "Cross" abaixo, que aceitam início/fim em meses diferentes.
    var mesFimNum = Number(Object.keys(NOMES_MESES).filter(function(k) { return NOMES_MESES[k] === mes; })[0]);
    var semanasSalvas = obterSemanasSalvas_().filter(function(s) { return s.mes === mes && s.ano === anoNum; });
    if (!semanasSalvas.length) {
      return JSON.stringify({ ok: true, semanas: {}, quinzenas: {}, avisos: [] });
    }

    var avisos = [];
    var rowsCompras = lerTodosCSVs('compras');
    var rowsVendas  = lerTodosCSVs('vendas');
    var rowsFichas  = lerFichaTecnica();
    var fichasMap   = processarFichas(rowsFichas);
    var historicoPorInsumo = preAgregarCustoMedioPorInsumo(rowsCompras);
    var catalogo    = preAgregarCatalogoProdutos(rowsCompras, rowsVendas);
    var catalogoPorCodigo = preAgregarCatalogoPorCodigo(rowsCompras);
    var fichaPorCodigo = preAgregarFichaPorCodigo(rowsFichas);
    var porDiaCompras = preAgregarComprasPorDia(rowsCompras);
    var porDiaVendas  = preAgregarVendasPorDia(rowsVendas);

    var inventarios = obterInventariosSalvos_();
    var invPorId = {};
    inventarios.forEach(function(i) { invPorId[i.id] = i; });
    var dataPorContagemId = lerDataPorContagemId_();

    // Resolve cada semana salva num "bloco" com EI/EF já valorizado e o
    // dia inicial/final reais — usado tanto pra exibir a semana isolada
    // quanto pra montar as quinzenas (soma de duas semanas consecutivas).
    var blocos = {}; // 'semanaNum|unidade' -> bloco
    semanasSalvas.forEach(function(s) {
      var invInicial = invPorId[s.inventarioInicialId];
      var invFinal   = invPorId[s.inventarioFinalId];
      if (!invInicial || !invFinal) {
        avisos.push('Semana ' + s.semanaNum + ' (' + s.unidade + '): um dos inventários referenciados não existe mais — reconfigure em Ajustes > Inventário.');
        return;
      }
      var infoInicial = resolverDataInventario_(invInicial, dataPorContagemId);
      var infoFinal   = resolverDataInventario_(invFinal, dataPorContagemId);
      if (!infoInicial || !infoFinal) {
        avisos.push('Semana ' + s.semanaNum + ' (' + s.unidade + '): não foi possível resolver a data de um dos inventários.');
        return;
      }

      var itensInicial = buscarItensDeContagens_(invInicial.contagemIds);
      var itensFinal   = buscarItensDeContagens_(invFinal.contagemIds);
      var rotulo = mes + '/' + ano + ', Semana ' + s.semanaNum + ', ' + s.unidade;
      // O início pode ser de um mês diferente do fim (ver validação em
      // salvarSemana) -- por isso valoriza cada lado pelo CUSTO MÉDIO
      // PONDERADO DO SEU PRÓPRIO MÊS, nunca pelo mês do fim: um item
      // contado em 31/08 tem que usar o preço médio de Agosto, não o de
      // Setembro, senão o EI fica com o custo errado.
      var mesNomeInicial = NOMES_MESES[infoInicial.mes];
      var valInicial = valorizarItensInventario_(itensInicial, mesNomeInicial, infoInicial.ano, historicoPorInsumo, fichasMap, catalogo, rotulo + ' (inicial)', catalogoPorCodigo, fichaPorCodigo);
      var valFinal   = valorizarItensInventario_(itensFinal, mes, anoNum, historicoPorInsumo, fichasMap, catalogo, rotulo + ' (final)', catalogoPorCodigo, fichaPorCodigo);
      avisos = avisos.concat(valInicial.avisos).concat(valFinal.avisos);

      blocos[s.semanaNum + '|' + s.unidade] = {
        semanaNum: s.semanaNum, unidade: s.unidade,
        diaInicio: infoInicial.dia, diaFim: infoFinal.dia,
        mesInicioNum: infoInicial.mes, anoInicio: infoInicial.ano,
        dataInicio: pad2(infoInicial.dia) + '/' + pad2(infoInicial.mes) + '/' + infoInicial.ano,
        dataFim: pad2(infoFinal.dia) + '/' + pad2(infoFinal.mes) + '/' + infoFinal.ano,
        ei: valInicial.total, ef: valFinal.total,
        eiPorProduto: valInicial.porProduto, efPorProduto: valFinal.porProduto,
        labelInicial: invInicial.label, labelFinal: invFinal.label
      };
    });

    // Monta o resultado de UM período (uma semana, ou a junção de duas
    // semanas no caso das quinzenas): soma compras/vendas REAIS do
    // intervalo de dias entre EI e EF, pra uma unidade específica.
    // OBS: o dia da contagem conta inteiro na semana em que ele é EF (ex:
    // contagem do dia 10 fecha a Semana 1 E abre a Semana 2 — as compras
    // desse dia aparecem nas DUAS semanas isoladas). Por isso a soma de
    // "Semana 1 + Semana 2" pode ficar um pouco ACIMA da Quinzena (que soma
    // o intervalo contínuo uma vez só, sem repetir o dia de fronteira) — a
    // Quinzena é sempre o número certo pro período combinado, nunca a soma
    // manual das duas semanas.
    // eiPorProduto/efPorProduto (opcionais): quando informados, também monta
    // o detalhe por grupo/produto de CMC e CMV desse período/unidade -- mesmo
    // formato de cmc[mes] e cmv[mes].filiais[unidade], pra alimentar as
    // mesmas telas ricas de "Análise Mês a Mês" e "CMV" (rMes/rCMV) sem
    // precisar reescrevê-las.
    function montarPeriodo(ei, ef, mesIniNum, anoIni, diaInicio, diaFim, unidade, eiPorProduto, efPorProduto) {
      var compras = somarPeriodoPreAgregadoCross_(porDiaCompras, mesIniNum, anoIni, diaInicio, mesFimNum, anoNum, diaFim);
      var vendas  = somarPeriodoPreAgregadoCross_(porDiaVendas, mesIniNum, anoIni, diaInicio, mesFimNum, anoNum, diaFim);
      var compraUni = compras.filiais[unidade] || 0;
      var vendaUni  = vendas.filiais[unidade]  || 0;
      var cmv = r2(ei + compraUni - ef);
      var resultado = {
        ei: r2(ei), ef: r2(ef), compras: r2(compraUni), faturamento: r2(vendaUni), cmv: cmv,
        cmc_pct: calcularPct(compraUni, vendaUni),
        cmv_pct: calcularPct(cmv, vendaUni)
      };
      if (eiPorProduto && efPorProduto) {
        var cmcDetalhado = processarComprasIntervaloDiasCross_(rowsCompras, mesIniNum, anoIni, diaInicio, mesFimNum, anoNum, diaFim);
        injetarFaturamentoCmcPeriodo_(cmcDetalhado, porDiaVendas, mesIniNum, anoIni, diaInicio, mesFimNum, anoNum, diaFim);
        resultado.cmcDetalhado = cmcDetalhado;
        resultado.cmvDetalhado = montarCMVDetalhadoUnidade_(eiPorProduto, efPorProduto, rowsCompras, mesIniNum, anoIni, diaInicio, mesFimNum, anoNum, diaFim, unidade);
      }
      return resultado;
    }

    // Soma o consolidado "TODAS" a partir das unidades JÁ CALCULADAS de um
    // período (nunca soma compras/vendas de unidades sem semana salva —
    // ficaria misturando EI/EF parcial com compras da empresa inteira).
    function consolidarTodas(mapaPorUnidade) {
      var unidades = Object.keys(mapaPorUnidade);
      if (!unidades.length) return null;
      var ei = 0, ef = 0, compras = 0, faturamento = 0;
      unidades.forEach(function(u) {
        ei += mapaPorUnidade[u].ei; ef += mapaPorUnidade[u].ef;
        compras += mapaPorUnidade[u].compras; faturamento += mapaPorUnidade[u].faturamento;
      });
      var cmv = r2(ei + compras - ef);
      return {
        ei: r2(ei), ef: r2(ef), compras: r2(compras), faturamento: r2(faturamento), cmv: cmv,
        cmc_pct: calcularPct(compras, faturamento), cmv_pct: calcularPct(cmv, faturamento),
        unidadesIncompletas: unidades.length < 3
      };
    }

    var semanas = { 1: {}, 2: {}, 3: {}, 4: {} };
    Object.keys(blocos).forEach(function(chave) {
      var b = blocos[chave];
      var periodo = montarPeriodo(b.ei, b.ef, b.mesInicioNum, b.anoInicio, b.diaInicio, b.diaFim, b.unidade, b.eiPorProduto, b.efPorProduto);
      semanas[b.semanaNum][b.unidade] = Object.assign({
        dataInicio: b.dataInicio, dataFim: b.dataFim,
        labelInicial: b.labelInicial, labelFinal: b.labelFinal
      }, periodo);
    });
    [1, 2, 3, 4].forEach(function(n) {
      var consolidado = consolidarTodas(semanas[n]);
      if (!consolidado) return;
      if (consolidado.unidadesIncompletas) {
        avisos.push('Semana ' + n + ' de ' + mes + '/' + ano + ': só ' + Object.keys(semanas[n]).length +
          ' unidade(s) configurada(s) — o consolidado "Todas" fica incompleto até configurar as demais.');
      }
      semanas[n]['TODAS'] = consolidado;
    });

    // Quinzenas: 1ª = Semana 1 (início) + Semana 2 (fim); 2ª = Semana 3
    // (início) + Semana 4 (fim). Só monta pra uma unidade se as DUAS
    // semanas da quinzena tiverem bloco salvo pra essa mesma unidade.
    var quinzenas = {};
    function montarQuinzena(nomeQ, nSemInicio, nSemFim) {
      var porUnidade = {};
      var unidadesComInicio = Object.keys(blocos)
        .filter(function(chave) { return blocos[chave].semanaNum === nSemInicio; })
        .map(function(chave) { return blocos[chave].unidade; });

      unidadesComInicio.forEach(function(u) {
        var bIni = blocos[nSemInicio + '|' + u];
        var bFim = blocos[nSemFim + '|' + u];
        if (!bFim) return; // essa unidade ainda não tem a segunda semana da quinzena salva
        porUnidade[u] = Object.assign({
          dataInicio: bIni.dataInicio, dataFim: bFim.dataFim
        }, montarPeriodo(bIni.ei, bFim.ef, bIni.mesInicioNum, bIni.anoInicio, bIni.diaInicio, bFim.diaFim, u, bIni.eiPorProduto, bFim.efPorProduto));
      });

      if (!Object.keys(porUnidade).length) return;
      var consolidado = consolidarTodas(porUnidade);
      if (consolidado) porUnidade['TODAS'] = consolidado;
      quinzenas[nomeQ] = porUnidade;
    }
    montarQuinzena('primeira', 1, 2);
    montarQuinzena('segunda', 3, 4);

    return JSON.stringify({ ok: true, semanas: semanas, quinzenas: quinzenas, avisos: avisos });
  } catch (err) {
    Logger.log('calcularAnaliseSemanal ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Índices reais da aba ITENS_CONTAGEM — confirmados com quem mantém o
// sistema de contagem: a função de gravação (salvarContagem) escreve só 5
// colunas, sempre nesta ordem: CONTAGEM_ID, COD, PRODUTO, UND, CONTADO
// (índice 4 pro valor contado). O cabeçalho de 7 colunas que existe na
// planilha (com MIN, MAX, SUGESTAO) não corresponde a nada que o backend
// escreva — foi inserido manualmente em algum momento pra uma feature que
// nunca saiu do papel. Por isso essas 3 colunas nunca têm valor confiável.
var C_ITENS_CONTAGEM = { contagemId: 0, cod: 1, produto: 2, und: 3, contado: 4 };

// Soma o CONTADO por PRODUTO (nome) de uma seleção de inventário semanal já
// salva — casa pelo NOME do produto (não pelo COD), porque o resto do
// sistema (compras/vendas/estoque do Cloudfy) já casa tudo por nome, e o
// nome já vem certo na própria aba ITENS_CONTAGEM.
function buscarItensDoInventarioSalvo(senha, inventarioId) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var props = PropertiesService.getScriptProperties();
    var valor = props.getProperty('INVENTARIOS_SEMANAIS_SALVOS');
    var lista = valor ? JSON.parse(valor) : [];
    var inv = null;
    for (var i = 0; i < lista.length; i++) { if (lista[i].id === inventarioId) { inv = lista[i]; break; } }
    if (!inv) return JSON.stringify({ ok: false, erro: 'Seleção de inventário não encontrada.' });

    var itens = buscarItensDeContagens_(inv.contagemIds);
    return JSON.stringify({ ok: true, label: inv.label, unidade: inv.unidade, itens: itens });
  } catch (err) {
    Logger.log('buscarItensDoInventarioSalvo ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Helper interno (sem checagem de senha própria — só chamado por funções
// que já validaram): soma CONTADO por item pra uma lista de contagemIds.
// Agrupa pelo COD quando existe (identificador mais confiável — o nome do
// produto pode vir com grafia levemente diferente entre contagens do
// mesmo item), caindo pro nome do produto só se o COD vier vazio.
// Cada item carrega também "fontes" (contagemId + linha de cada lançamento
// que contribuiu pra soma) — usado pra permitir corrigir a contagem exata
// direto da aba CMV, sem precisar procurar manualmente em Ajustes >
// Inventário (ver abrirCorrecaoDeItem).
function buscarItensDeContagens_(contagemIds) {
  var ss  = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
  var aba = ss.getSheetByName('ITENS_CONTAGEM');
  if (!aba) throw new Error('Aba ITENS_CONTAGEM não encontrada na planilha.');

  var idsValidos = {};
  contagemIds.forEach(function(id) { idsValidos[String(id).trim()] = true; });

  var rows = aba.getDataRange().getValues();
  var mapa = {};
  for (var j = 1; j < rows.length; j++) {
    var r = rows[j];
    var cid = String(r[C_ITENS_CONTAGEM.contagemId]).trim();
    if (!idsValidos[cid]) continue;
    var produto = String(r[C_ITENS_CONTAGEM.produto]).trim();
    if (!produto) continue;
    var cod = String(r[C_ITENS_CONTAGEM.cod] || '').trim();
    var contado = Number(r[C_ITENS_CONTAGEM.contado]) || 0;
    var und = String(r[C_ITENS_CONTAGEM.und] || '').trim();
    var chave = cod || produto;
    if (!mapa[chave]) mapa[chave] = { produto: produto, cod: cod, und: und, qtde: 0, fontes: [] };
    mapa[chave].qtde += contado;
    mapa[chave].fontes.push({ contagemId: cid, linha: j + 1 });
  }
  return Object.values(mapa);
}

// Monta, numa única leitura, tudo que valorizarItensInventario_ precisa
// pra precificar itens contados (mesma cadeia do CMV Teórico/conector
// mensal/semanal). Reaproveitado sempre que precisar valorizar itens fora
// desses fluxos principais (lista de contagens, tela de correção).
function construirContextoPrecificacao_() {
  var rowsCompras = lerTodosCSVs('compras');
  var rowsVendas  = lerTodosCSVs('vendas');
  var rowsFichas  = lerFichaTecnica();
  var fichasMap   = processarFichas(rowsFichas);
  return {
    fichasMap: fichasMap,
    historicoPorInsumo: preAgregarCustoMedioPorInsumo(rowsCompras),
    catalogo: preAgregarCatalogoProdutos(rowsCompras, rowsVendas),
    catalogoPorCodigo: preAgregarCatalogoPorCodigo(rowsCompras),
    fichaPorCodigo: preAgregarFichaPorCodigo(rowsFichas)
  };
}

// Resolve o mês/ano de UMA contagem a partir da aba CONTAGENS (sua própria
// data — diferente de resolverDataInventario_, que combina VÁRIAS
// contagens de um inventário salvo). Retorna null se não achar.
function resolverMesAnoDaContagem_(abaCont, contagemId) {
  if (!abaCont) return null;
  var contRows = abaCont.getDataRange().getValues();
  for (var i = 1; i < contRows.length; i++) {
    var r = contRows[i];
    if (String(r[0]).trim() !== String(contagemId).trim()) continue;
    var dataTxt = paraTextoData_(r[1]) || paraTextoData_(r[7]);
    var info = dataTxt ? parseDataCompleta(dataTxt.split(' ')[0]) : null;
    return info ? { mesNome: NOMES_MESES[info.mes], ano: info.ano } : null;
  }
  return null;
}

// Lista os itens CRUS de UMA contagem específica (não agregados — cada
// linha da planilha vira um item, com o número da linha, pra permitir
// corrigir o CONTADO diretamente na planilha do sistema de contagem (ver
// editarContadoItem). Já vem com o custo unitário/total de cada item e o
// valor total da contagem, pela mesma precificação usada em todo o resto
// do sistema.
function listarItensDeContagem(senha, contagemId) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var ss  = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
    var aba = ss.getSheetByName('ITENS_CONTAGEM');
    if (!aba) return JSON.stringify({ ok: false, erro: 'Aba ITENS_CONTAGEM não encontrada na planilha.' });

    var rows = aba.getDataRange().getValues();
    var itens = [];
    for (var i = 1; i < rows.length; i++) {
      var r = rows[i];
      if (String(r[C_ITENS_CONTAGEM.contagemId]).trim() !== String(contagemId).trim()) continue;
      itens.push({
        linha: i + 1, // 1-indexado (linha real da planilha), usado só pra escrever de volta
        cod: String(r[C_ITENS_CONTAGEM.cod] || '').trim(),
        produto: String(r[C_ITENS_CONTAGEM.produto]).trim(),
        und: String(r[C_ITENS_CONTAGEM.und] || '').trim(),
        qtde: Number(r[C_ITENS_CONTAGEM.contado]) || 0
      });
    }
    itens.sort(function(a, b) { return a.produto.localeCompare(b.produto); });

    var valorTotal = null, avisos = [];
    var infoData = resolverMesAnoDaContagem_(ss.getSheetByName('CONTAGENS'), contagemId);
    if (infoData) {
      var ctx = construirContextoPrecificacao_();
      var res = valorizarItensInventario_(itens, infoData.mesNome, infoData.ano, ctx.historicoPorInsumo, ctx.fichasMap, ctx.catalogo, 'contagem ' + contagemId, ctx.catalogoPorCodigo, ctx.fichaPorCodigo);
      valorTotal = res.total;
      avisos = res.avisos;
      var custoPorLinha = {};
      res.porProduto.forEach(function(p) { custoPorLinha[p.linha] = { custoUnit: p.custoUnit, custoTotal: p.custoTotal }; });
      itens.forEach(function(it) {
        var c = custoPorLinha[it.linha];
        it.contado = it.qtde; // nome usado na tela hoje
        it.custoUnit = c ? c.custoUnit : null;
        it.custoTotal = c ? c.custoTotal : null;
      });
    } else {
      itens.forEach(function(it) { it.contado = it.qtde; it.custoUnit = null; it.custoTotal = null; });
    }

    return JSON.stringify({ ok: true, itens: itens, valorTotal: valorTotal, avisos: avisos });
  } catch (err) {
    Logger.log('listarItensDeContagem ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Lê data/unidade/setor de UMA contagem na aba CONTAGENS — só pra montar um
// rótulo legível (ex: "08/09/2026 · Umarizal · Bar") na tela de correção.
// Retorna null se a contagem não existir mais.
function resolverContagemMeta_(contagemId) {
  var ss  = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
  var aba = ss.getSheetByName('CONTAGENS');
  if (!aba) return null;
  var rows = aba.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[0]).trim() === String(contagemId).trim()) {
      return { data: String(r[1]).trim(), unidade: String(r[2]).trim(), setor: String(r[3]).trim() };
    }
  }
  return null;
}

// Ponto de entrada do botão "Corrigir" que aparece direto num produto da
// aba CMV (quando o EI/EF desse produto vem de UMA única contagem
// identificável — ver ei_fontes/ef_fontes em montarGruposCMV_). Devolve, num
// só round-trip, os mesmos itens de listarItensDeContagem MAIS o rótulo
// (data/unidade/setor) da contagem, pra abrir a tela de correção já
// contextualizada sem precisar navegar por Ajustes > Inventário.
function abrirCorrecaoDeItem(senha, contagemId) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var meta = resolverContagemMeta_(contagemId);
    var base = JSON.parse(listarItensDeContagem(senha, contagemId));
    base.meta = meta;
    return JSON.stringify(base);
  } catch (err) {
    Logger.log('abrirCorrecaoDeItem ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Calcula o valor total (R$) de CADA contagem de uma unidade, usando a
// mesma precificação do resto do sistema — pra mostrar "Valor Total" na
// lista de Contagens Registradas (Ajustes > Inventário), sem precisar
// abrir uma a uma.
function listarValoresContagens(senha, unidade) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var ss = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
    var abaCont  = ss.getSheetByName('CONTAGENS');
    var abaItens = ss.getSheetByName('ITENS_CONTAGEM');
    if (!abaCont || !abaItens) return JSON.stringify({ ok: false, erro: 'Abas de contagem não encontradas na planilha.' });

    var contRows = abaCont.getDataRange().getValues();
    var infoPorContagem = {}; // id -> {mesNome, ano}
    for (var i = 1; i < contRows.length; i++) {
      var r = contRows[i];
      if (!r[0] || String(r[2]).trim() !== unidade) continue;
      var dataTxt = paraTextoData_(r[1]) || paraTextoData_(r[7]);
      var info = dataTxt ? parseDataCompleta(dataTxt.split(' ')[0]) : null;
      if (info) infoPorContagem[String(r[0]).trim()] = { mesNome: NOMES_MESES[info.mes], ano: info.ano };
    }
    if (!Object.keys(infoPorContagem).length) return JSON.stringify({ ok: true, valores: {} });

    var itRows = abaItens.getDataRange().getValues();
    var itensPorContagem = {};
    for (var j = 1; j < itRows.length; j++) {
      var ir = itRows[j];
      var cid = String(ir[C_ITENS_CONTAGEM.contagemId]).trim();
      if (!infoPorContagem[cid]) continue;
      var produto = String(ir[C_ITENS_CONTAGEM.produto]).trim();
      if (!produto) continue;
      if (!itensPorContagem[cid]) itensPorContagem[cid] = [];
      itensPorContagem[cid].push({
        cod: String(ir[C_ITENS_CONTAGEM.cod] || '').trim(),
        produto: produto,
        und: String(ir[C_ITENS_CONTAGEM.und] || '').trim(),
        qtde: Number(ir[C_ITENS_CONTAGEM.contado]) || 0
      });
    }

    var ctx = construirContextoPrecificacao_();
    var valores = {};
    Object.keys(infoPorContagem).forEach(function(cid) {
      var info = infoPorContagem[cid];
      var itens = itensPorContagem[cid] || [];
      var res = valorizarItensInventario_(itens, info.mesNome, info.ano, ctx.historicoPorInsumo, ctx.fichasMap, ctx.catalogo, 'contagem ' + cid, ctx.catalogoPorCodigo, ctx.fichaPorCodigo);
      valores[cid] = res.total;
    });

    return JSON.stringify({ ok: true, valores: valores });
  } catch (err) {
    Logger.log('listarValoresContagens ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Corrige o CONTADO de UM item, escrevendo direto na planilha do sistema
// de contagem (diferente de tudo mais neste projeto, que só LÊ essa
// planilha). Confere que a linha ainda pertence à mesma contagem antes de
// escrever — protege contra a linha ter sido deslocada por alguém
// inserindo/removendo linhas entre a leitura e a edição.
function editarContadoItem(senha, contagemId, linha, novoContado) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var valor = numVal(novoContado);
    if (!(valor >= 0)) return JSON.stringify({ ok: false, erro: 'Quantidade inválida.' });

    var ss  = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
    var aba = ss.getSheetByName('ITENS_CONTAGEM');
    if (!aba) return JSON.stringify({ ok: false, erro: 'Aba ITENS_CONTAGEM não encontrada na planilha.' });

    var linhaNum = Number(linha);
    var cidNaLinha = String(aba.getRange(linhaNum, C_ITENS_CONTAGEM.contagemId + 1).getValue()).trim();
    if (cidNaLinha !== String(contagemId).trim()) {
      return JSON.stringify({ ok: false, erro: 'A linha mudou de posição na planilha — recarregue a lista e tente de novo.' });
    }

    aba.getRange(linhaNum, C_ITENS_CONTAGEM.contado + 1).setValue(valor);
    Logger.log('CONTADO editado: contagem ' + contagemId + ', linha ' + linhaNum + ' -> ' + valor);
    return JSON.stringify({ ok: true, contado: valor });
  } catch (err) {
    Logger.log('editarContadoItem ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Converte um valor de célula de data em texto "dd/MM/yyyy" (ou "dd/MM/yyyy HH:mm..."),
// tratando tanto texto quanto células que o Sheets já devolve como objeto Date.
function paraTextoData_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, 'America/Belem', 'dd/MM/yyyy');
  }
  return String(v).trim();
}

// ── GERAÇÃO DE LINHAS DE ESTOQUE SINTÉTICAS A PARTIR DO INVENTÁRIO SALVO ──
//
// Conecta o CONTADO (sistema de contagem separado) no cálculo de CMV/CMC,
// SEM tocar em nenhum mês que já é calculado hoje a partir dos CSVs de
// estoque enviados manualmente (Ajustes > Contagem Inicial/Final):
//
//   - Um mês só passa a usar o inventário salvo se NÃO existir NENHUMA
//     linha de estoque (CSV) válida naquele mês. Se já existe CSV pro mês,
//     as seleções de inventário salvas daquele mês são ignoradas no
//     cálculo (continuam salvas e editáveis, só não entram no CMV).
//   - Dentro de um mês "novo" (sem CSV), se existir mais de uma seleção
//     salva pra UMA MESMA unidade (ex: 2 semanas do Marco em agosto), só a
//     mais recente por data conta como o fechamento do mês daquela unidade
//     — mesma regra que o sistema já usa hoje pra CSV (tsInicialEFinalDoMes:
//     fica com a contagem mais recente do mês).
//   - Unidades diferentes fechando em dias diferentes dentro do mesmo mês
//     (ex: Marco no domingo, Umarizal na segunda) são ancoradas na MESMA
//     data sintética (a mais recente entre elas) — o motor de CMV
//     (processarCMV) pressupõe uma única "foto" por data pra todas as
//     unidades, igual ao CSV consolidado do Cloudfy. É uma aproximação de
//     poucos dias, do mesmo tamanho da que já existe hoje quando as
//     contagens não caem exatamente no fim do mês.
//   - Preço de cada item: mesmo custo médio ponderado de compra do mês (com
//     fallback pro mês anterior) usado no CMV Teórico (ver
//     preAgregarCustoMedioPorInsumo / buscarCustoInsumoComFallback em
//     Dados.js); se o item nunca foi comprado com preço válido (comum em
//     itens preparados internamente, tipo "PP ..."), cai no custo estático
//     da própria ficha técnica (fichasMap) — mesma cadeia de fallback do
//     CMV Teórico. Item sem nenhum dos dois (nem compra, nem ficha) fica de
//     fora (sem preço não dá pra somar ao estoque) e entra na lista de avisos.
//
// Lê a aba CONTAGENS uma única vez e monta { contagemId: "dd/MM/yyyy ..." }.
// Reaproveitada por qualquer função que precise resolver a data de
// inventários salvos (conector mensal, Semanas do Mês).
function lerDataPorContagemId_() {
  var ss = SpreadsheetApp.openById(CONTAGEM_SHEET_ID);
  var abaCont = ss.getSheetByName('CONTAGENS');
  var dataPorContagemId = {};
  if (abaCont) {
    var contRows = abaCont.getDataRange().getValues();
    for (var c = 1; c < contRows.length; c++) {
      var rc = contRows[c];
      if (!rc[0]) continue;
      // Prioriza a data da contagem (r[1]); só cai pro fechamento (r[7]) se faltar.
      dataPorContagemId[String(rc[0]).trim()] = paraTextoData_(rc[1]) || paraTextoData_(rc[7]);
    }
  }
  return dataPorContagemId;
}

// Resolve a data representativa de um inventário salvo: a mais recente
// entre as contagens escolhidas (contagemIds). Retorna o info de
// parseDataCompleta (ano/mes/dia/ts), ou null se nenhuma contagem tiver
// data válida.
function resolverDataInventario_(inv, dataPorContagemId) {
  var melhorTs = null, melhorInfo = null;
  (inv.contagemIds || []).forEach(function(cid) {
    var txt = dataPorContagemId[String(cid).trim()];
    if (!txt) return;
    var info = parseDataCompleta(txt.split(' ')[0]);
    if (!info) return;
    if (!melhorTs || info.ts > melhorTs) { melhorTs = info.ts; melhorInfo = info; }
  });
  return melhorInfo;
}

// Precifica uma lista de itens contados (produto, und, qtde — vindo de
// buscarItensDeContagens_) pelo mesmo custo médio ponderado de compra do
// mês (com fallback pro mês anterior e, por fim, pra ficha técnica) usado
// no CMV Teórico. Item sem preço nenhum (nem compra, nem ficha) fica de
// fora do total e entra nos avisos — "rotuloContexto" só identifica de
// onde veio o item, pro aviso ficar claro (não afeta o cálculo).
// Retorna { total, porProduto:[{produto,grupo,und,qtd,custoUnit,custoTotal}], avisos }.
function valorizarItensInventario_(itens, mesNome, ano, historicoPorInsumo, fichasMap, catalogo, rotuloContexto, catalogoPorCodigo, fichaPorCodigo) {
  var total = 0;
  var porProduto = [];
  var avisos = [];
  // semPreco: mesma exclusao dos avisos abaixo, mas estruturada (nao só
  // texto) -- usada pela planilha de "itens sem preço no CMV" (Ajustes >
  // Configurações), que precisa desses dados alem dos que ja vem prontos
  // em rowsEstoqueCompleto (itens excluidos aqui NUNCA viram linha
  // sintetica, entao um scan de rowsEstoqueCompleto sozinho nao os acha).
  var semPreco = [];
  (itens || []).forEach(function(item) {
    var cat = null;
    var casadoPorAproximacao = null;

    // 1ª tentativa (mais confiável): casar pelo COD do sistema de contagem
    // contra o Cód. ref. de Compras — não depende de grafia batendo,
    // confirmado com dados reais (ex: COD 1104 = "MP TOMATE KG" nos dois
    // sistemas).
    if (item.cod && catalogoPorCodigo && catalogoPorCodigo[item.cod]) {
      cat = catalogoPorCodigo[item.cod];
    }

    // 2ª tentativa: itens preparados internamente (nunca comprados, por
    // isso não aparecem em Compras) casam pelo MESMO código na Ficha
    // Técnica — confirmado com dados reais (ex: COD 377 = "PP CROQUETE
    // DE PIRARUCU UND" na contagem = "PP CROQUETE PIRARUCU UND" na
    // ficha, mesmo com a grafia levemente diferente).
    if (!cat && item.cod && fichaPorCodigo && fichaPorCodigo[item.cod]) {
      cat = { nome: fichaPorCodigo[item.cod], grupo: '' };
    }

    // Sem COD ou COD não encontrado em nenhum dos dois: o sistema de
    // contagem às vezes chama o item por um nome que não bate
    // com Compras/Ficha Técnica (ex: prefixo "MP" a mais) — resolve isso
    // usando o mesmo de-para de CMV Teórico.
    var nomeContado = APELIDOS_PRODUTO[item.produto] || item.produto;
    if (!cat) cat = catalogo[nomeContado.toUpperCase()];

    // Sem match por COD, nem exato, nem apelido: tenta achar UM único nome
    // em Compras (ou, se não achar, na Ficha Técnica) cujas palavras
    // contêm todas as palavras do nome contado (ex: "MP TOMATE" -> "MP
    // TOMATE KG"). Só resolve se for inequívoco — ver
    // acharUnicoPorSubconjuntoDePalavras_.
    if (!cat) {
      var chaveCatalogo = acharUnicoPorSubconjuntoDePalavras_(nomeContado, catalogo);
      if (chaveCatalogo) {
        cat = catalogo[chaveCatalogo];
        casadoPorAproximacao = cat.nome;
      } else if (fichasMap) {
        var chaveFicha = acharUnicoPorSubconjuntoDePalavras_(nomeContado, fichasMap);
        if (chaveFicha) casadoPorAproximacao = chaveFicha;
      }
    }

    var nomeCanonico = casadoPorAproximacao || (cat ? cat.nome : nomeContado);
    var grupo = cat ? cat.grupo : '';
    var custoUnit = buscarCustoInsumoComFallback(historicoPorInsumo, nomeCanonico, mesNome, ano);
    if ((custoUnit === null || custoUnit === undefined) && fichasMap) {
      custoUnit = fichasMap[nomeCanonico];
    }
    if (custoUnit === null || custoUnit === undefined) {
      avisos.push('Item "' + item.produto + '"' + (rotuloContexto ? ' (' + rotuloContexto + ')' : '') +
        ': sem histórico de compra nem ficha técnica — não entrou no valor do inventário.');
      semPreco.push({ produto: item.produto, mes: mesNome, ano: ano, contexto: rotuloContexto || '', qtd: item.qtde, und: item.und });
      return;
    }
    if (casadoPorAproximacao) {
      avisos.push('Item "' + item.produto + '"' + (rotuloContexto ? ' (' + rotuloContexto + ')' : '') +
        ': casado automaticamente com "' + nomeCanonico + '" (aproximação de nome) — confirme se é o mesmo produto.');
    }
    var custoTotal = r2(custoUnit * item.qtde);
    total += custoTotal;
    // linha: preenchido quando item vem de UMA contagem só (listarItensDeContagem/
    // listarValoresContagens, leitura direta da aba) -- usado ali pra casar
    // custo de volta pela linha. fontes: preenchido quando item vem de
    // VÁRIAS contagens combinadas (buscarItensDeContagens_, semana/quinzena)
    // -- usado pro botão "Corrigir" na aba CMV. Nunca os dois ao mesmo tempo.
    porProduto.push({ produto: nomeCanonico, grupo: grupo, und: item.und, qtd: item.qtde, custoUnit: custoUnit, custoTotal: custoTotal, linha: item.linha, fontes: item.fontes || [] });
  });
  return { total: r2(total), porProduto: porProduto, avisos: avisos, semPreco: semPreco };
}

// Retorna { linhas, avisos, semPreco } — linhas no MESMO formato de
// C_ESTOQUE, pra simplesmente concatenar com o rowsEstoque (CSV) antes de
// chamar processarCMV, sem mudar nada da lógica de cálculo em si. semPreco:
// itens excluídos por falta de preço (ver valorizarItensInventario_) --
// esses NUNCA viram linha, então só aparecem aqui, não num scan de rowsEstoque.
function gerarLinhasEstoqueDeInventariosSalvos_(rowsEstoque, rowsCompras, rowsVendas, historicoPorInsumo, fichasMap, rowsFichas) {
  var avisos = [];
  var semPrecoTotal = [];
  var props = PropertiesService.getScriptProperties();
  var valorProp = props.getProperty('INVENTARIOS_SEMANAIS_SALVOS');
  var inventarios = valorProp ? JSON.parse(valorProp) : [];
  if (!inventarios.length) return { linhas: [], avisos: avisos, semPreco: semPrecoTotal };

  // 1. Meses que já têm contagem via CSV — esses meses NÃO usam inventário salvo.
  var mesesComCSV = {};
  if (rowsEstoque && rowsEstoque.length > 1) {
    for (var i = 1; i < rowsEstoque.length; i++) {
      var r = rowsEstoque[i];
      if (!r || r.length < 16) continue;
      if (limpaCelula(r[C_ESTOQUE.tp_movto]) !== ESTOQUE_TIPO_VALIDO) continue;
      var dInfo = parseDataCompleta(r[C_ESTOQUE.data]);
      if (!dInfo) continue;
      mesesComCSV[dInfo.ano + '-' + dInfo.mes] = true;
    }
  }

  // 2. Data de cada contagem (aba CONTAGENS), pra achar a data representativa
  //    de cada inventário salvo.
  var dataPorContagemId = lerDataPorContagemId_();

  // 3. Agrupa por mês (ano-mes), pula meses que já têm CSV, e dentro de cada
  //    mês mantém só o inventário mais recente POR UNIDADE.
  var porMes = {}; // 'ano-mes' -> { unidade: {inv, info} }
  inventarios.forEach(function(inv) {
    if (!inv.contagemIds || !inv.contagemIds.length) return;
    var info = resolverDataInventario_(inv, dataPorContagemId);
    if (!info) {
      avisos.push('Inventário "' + inv.label + '" (' + inv.unidade + '): sem data válida encontrada nas contagens escolhidas — ignorado.');
      return;
    }

    var chaveMes = info.ano + '-' + info.mes;
    if (mesesComCSV[chaveMes]) {
      avisos.push('Inventário "' + inv.label + '" (' + inv.unidade + '): ' + NOMES_MESES[info.mes] + '/' + info.ano + ' já tem contagem via CSV — ignorado no cálculo (continua salvo).');
      return;
    }

    if (!porMes[chaveMes]) porMes[chaveMes] = {};
    var atual = porMes[chaveMes][inv.unidade];
    if (!atual || info.ts > atual.info.ts) {
      if (atual) {
        avisos.push('Inventário "' + atual.inv.label + '" (' + inv.unidade + '): substituído por "' + inv.label + '" como fechamento de ' + NOMES_MESES[info.mes] + '/' + info.ano + ' (data mais recente).');
      }
      porMes[chaveMes][inv.unidade] = { inv: inv, info: info };
    } else {
      avisos.push('Inventário "' + inv.label + '" (' + inv.unidade + '): não é o mais recente de ' + NOMES_MESES[info.mes] + '/' + info.ano + ' — ignorado no cálculo (continua salvo).');
    }
  });

  var chavesMes = Object.keys(porMes);
  if (!chavesMes.length) return { linhas: [], avisos: avisos, semPreco: semPrecoTotal };

  // 4. Preço/grupo: mesmo catálogo e histórico usados no CMV Teórico.
  var catalogo = preAgregarCatalogoProdutos(rowsCompras, rowsVendas);
  var catalogoPorCodigo = preAgregarCatalogoPorCodigo(rowsCompras);
  var fichaPorCodigo = preAgregarFichaPorCodigo(rowsFichas);
  var linhas = [];

  chavesMes.forEach(function(chaveMes) {
    var porUnidade = porMes[chaveMes];
    var unidades = Object.keys(porUnidade);

    // Data sintética compartilhada por TODAS as unidades desse mês: a mais
    // recente entre elas (ver nota no cabeçalho da função).
    var tsCompartilhado = null;
    unidades.forEach(function(u) {
      var ts = porUnidade[u].info.ts;
      if (!tsCompartilhado || ts > tsCompartilhado) tsCompartilhado = ts;
    });
    var infoData = parseDataCompleta(
      tsCompartilhado.slice(0, 4) + '-' + tsCompartilhado.slice(4, 6) + '-' + tsCompartilhado.slice(6, 8)
    );
    var dataFormatada = String(infoData.dia).padStart(2, '0') + '/' + String(infoData.mes).padStart(2, '0') + '/' + infoData.ano;
    var mesNome = NOMES_MESES[infoData.mes];

    unidades.forEach(function(u) {
      var entry = porUnidade[u];
      var itens = buscarItensDeContagens_(entry.inv.contagemIds);
      var rotulo = mesNome + '/' + infoData.ano + ', ' + u + ', ' + entry.inv.label;
      var valorizado = valorizarItensInventario_(itens, mesNome, infoData.ano, historicoPorInsumo, fichasMap, catalogo, rotulo, catalogoPorCodigo, fichaPorCodigo);
      avisos = avisos.concat(valorizado.avisos);
      semPrecoTotal = semPrecoTotal.concat((valorizado.semPreco || []).map(function(sp) {
        return { produto: sp.produto, mes: sp.mes, ano: sp.ano, contexto: sp.contexto, qtd: sp.qtd, und: sp.und, unidade: u };
      }));
      valorizado.porProduto.forEach(function(p) {
        var linha = [];
        linha[C_ESTOQUE.filial]      = u;
        linha[C_ESTOQUE.grupo]       = p.grupo;
        linha[C_ESTOQUE.produto]     = p.produto;
        linha[C_ESTOQUE.unid]        = p.und;
        linha[C_ESTOQUE.data]        = dataFormatada;
        linha[C_ESTOQUE.centro]      = entry.inv.label;
        linha[C_ESTOQUE.tp_movto]    = ESTOQUE_TIPO_VALIDO;
        linha[C_ESTOQUE.saldo]       = p.qtd;
        linha[C_ESTOQUE.custo_unit]  = p.custoUnit;
        linha[C_ESTOQUE.custo_total] = p.custoTotal;
        linhas.push(linha);
      });
    });
  });

  return { linhas: linhas, avisos: avisos, semPreco: semPrecoTotal };
}

// ── UPLOAD DE RELATÓRIOS ──────────────────────────────────────

// Detecta o tipo do arquivo pelo nome, usando os mesmos padrões da leitura.
// Retorna null se o nome não bater com nenhum tipo reconhecido.
function detectarTipoArquivo(nome) {
  var tipos = Object.keys(PADROES);
  for (var i = 0; i < tipos.length; i++) {
    if (PADROES[tipos[i]].test(nome)) return tipos[i];
  }
  return null;
}

// Recebe um arquivo em base64 do navegador e salva na pasta do painel.
// O TIPO vem escolhido pelo usuario na tela (compras/vendas/estoque) e, para
// esses tipos, tambem o MES/ANO escolhidos — o arquivo e renomeado para
// "<tipo>_<mes>_<ano>.csv" antes de salvar, DESCARTANDO o nome original do
// Cloudfy (que costuma vir com codigo/hash ilegivel). O nome final depende
// só do que o usuario escolheu na tela, nunca do nome que o Cloudfy gerou.
// Se ja existir um arquivo com o MESMO NOME FINAL, ele e movido para a
// lixeira do Drive (recuperavel) antes de salvar o novo.
function uploadArquivo(senha, nomeArquivoOriginal, conteudoBase64, tipo, mes, ano) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    if (!nomeArquivoOriginal || !nomeArquivoOriginal.toLowerCase().endsWith('.csv')) {
      return JSON.stringify({ ok: false, erro: 'Só são aceitos arquivos .csv.' });
    }
    if (!tipo || !PADROES[tipo]) {
      return JSON.stringify({ ok: false, erro: 'Tipo de relatório inválido.' });
    }
    if (!conteudoBase64) {
      return JSON.stringify({ ok: false, erro: 'Arquivo vazio ou não recebido corretamente.' });
    }
    if (tipo !== 'fichas' && (!mes || !ano)) {
      return JSON.stringify({ ok: false, erro: 'Mês e ano do relatório não informados.' });
    }

    // Ficha técnica é uma FOTO do momento (não acumula por mês como os outros
    // tipos) — usa sempre o mesmo nome, então um novo envio substitui o
    // anterior automaticamente, nunca fica mais de uma versão coexistindo.
    var nomeFinal;
    if (tipo === 'fichas') {
      nomeFinal = 'fichas_tecnicas.csv';
    } else {
      var mesSlug = String(mes).toLowerCase().replace(/[^a-z0-9]/g, '');
      var anoSlug = String(ano).replace(/[^0-9]/g, '');
      nomeFinal = tipo + '_' + mesSlug + '_' + anoSlug + '.csv';
    }

    var pasta = DriveApp.getFolderById(PASTA_ID);

    // Substitui: manda pra lixeira qualquer arquivo existente com o MESMO nome final.
    var substituido = false;
    var existentes = pasta.getFilesByName(nomeFinal);
    while (existentes.hasNext()) {
      existentes.next().setTrashed(true);
      substituido = true;
    }

    var bytes = Utilities.base64Decode(conteudoBase64);
    var blob  = Utilities.newBlob(bytes, 'text/csv', nomeFinal);
    pasta.createFile(blob);

    Logger.log('Upload: ' + nomeFinal + ' (original: ' + nomeArquivoOriginal + ')' + (substituido ? ' — substituiu arquivo anterior' : ''));
    return JSON.stringify({ ok: true, nome: nomeFinal, tipo: tipo, substituido: substituido });

  } catch (err) {
    Logger.log('uploadArquivo ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Lista os CSVs atualmente na pasta do painel (pra exibir na aba de Relatórios).
function listarArquivos(senha) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var pasta = DriveApp.getFolderById(PASTA_ID);
    var files = pasta.getFiles();
    var lista = [];
    while (files.hasNext()) {
      var f = files.next();
      var nome = f.getName();
      if (!nome.toLowerCase().endsWith('.csv')) continue;
      lista.push({
        nome: nome,
        tipo: detectarTipoArquivo(nome) || 'outro',
        tamanho: f.getSize(),
        atualizado: f.getLastUpdated().toISOString()
      });
    }
    lista.sort(function(a, b) { return b.atualizado.localeCompare(a.atualizado); });
    return JSON.stringify({ ok: true, arquivos: lista });

  } catch (err) {
    Logger.log('listarArquivos ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Move um arquivo da pasta do painel para a lixeira do Drive (recuperável, não é exclusão definitiva).
function excluirArquivo(senha, nomeArquivo) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    if (!nomeArquivo) {
      return JSON.stringify({ ok: false, erro: 'Nome de arquivo não informado.' });
    }
    var pasta = DriveApp.getFolderById(PASTA_ID);
    var existentes = pasta.getFilesByName(nomeArquivo);
    var achou = false;
    while (existentes.hasNext()) {
      existentes.next().setTrashed(true);
      achou = true;
    }
    if (!achou) {
      return JSON.stringify({ ok: false, erro: 'Arquivo não encontrado na pasta.' });
    }
    Logger.log('Excluido (lixeira): ' + nomeArquivo);
    return JSON.stringify({ ok: true, nome: nomeArquivo });

  } catch (err) {
    Logger.log('excluirArquivo ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// ── EDIÇÃO DE DADOS BRUTOS (Compras e Contagem de Estoque) ────
// Permite ver e corrigir a QUANTIDADE de uma linha específica direto no
// arquivo de origem no Drive, sem precisar reexportar do Cloudfy. Cada
// linha devolvida ao front-end carrega "arquivo" + "linha" (posição física
// no arquivo) para a edição saber exatamente o que reescrever.

// Formata número no padrão BR (vírgula decimal), sem notação científica.
function formatBR(n, decimais) {
  var f = Math.pow(10, decimais);
  return (Math.round(n * f) / f).toFixed(decimais).replace('.', ',');
}

// Lista os arquivos CSV de um tipo, ordenados por nome (mesma varredura da
// leitura agregada, mas devolvendo os File objects — usado pela edição).
function arquivosDoTipo(tipo) {
  var pasta = DriveApp.getFolderById(PASTA_ID);
  var files = pasta.getFiles();
  var padrao = PADROES[tipo];
  var encontrados = [];
  while (files.hasNext()) {
    var f = files.next();
    var nome = f.getName();
    if (!nome.toLowerCase().endsWith('.csv')) continue;
    if (!padrao.test(nome)) continue;
    encontrados.push(f);
  }
  encontrados.sort(function(a, b) { return a.getName().localeCompare(b.getName()); });
  return encontrados;
}

function conteudoDoArquivo(file) {
  try { return file.getBlob().getDataAsString('UTF-8'); }
  catch (enc) { return file.getBlob().getDataAsString('ISO-8859-1'); }
}

// Lista as linhas de COMPRAS do mês selecionado, com metadados de origem
// (arquivo + linha) para permitir a edição da quantidade.
function listarComprasMes(senha, mesNome) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var resultado = [];
    arquivosDoTipo('compras').forEach(function(f) {
      var linhasTexto = conteudoDoArquivo(f).split(/\r?\n/);
      for (var i = 1; i < linhasTexto.length; i++) {
        if (!linhasTexto[i]) continue;
        var cel = linhasTexto[i].split('\t').map(function(c) { return c.replace(/^"|"$/g, ''); });
        if (cel.length < 18) continue;
        var mes = mesNum(cel[C_COMPRAS.data]);
        if (!mes || NOMES_MESES[mes] !== mesNome) continue;
        resultado.push({
          arquivo: f.getName(), linha: i,
          filial: cel[C_COMPRAS.filial], data: cel[C_COMPRAS.data],
          produto: cel[C_COMPRAS.produto], grupo: cel[C_COMPRAS.grupo],
          qtd: numVal(cel[C_COMPRAS.qtd]), unid: cel[C_COMPRAS.unid],
          custo_unit: numVal(cel[C_COMPRAS.custo_atual]), total: numVal(cel[C_COMPRAS.total])
        });
      }
    });
    resultado.sort(function(a, b) { return b.total - a.total; });
    return JSON.stringify({ ok: true, linhas: resultado });
  } catch (err) {
    Logger.log('listarComprasMes ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Corrige a quantidade de UMA linha de compra, recalculando o Total
// (Qtd x Custo atual — o custo atual fica inalterado). Escreve direto no
// arquivo de origem no Drive.
function editarQtdCompra(senha, arquivo, linha, novaQtd) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var qtd = numVal(novaQtd);
    if (!(qtd >= 0)) return JSON.stringify({ ok: false, erro: 'Quantidade inválida.' });

    var it = DriveApp.getFolderById(PASTA_ID).getFilesByName(arquivo);
    if (!it.hasNext()) return JSON.stringify({ ok: false, erro: 'Arquivo não encontrado: ' + arquivo });
    var file = it.next();

    var linhasTexto = conteudoDoArquivo(file).split(/\r?\n/);
    var idx = Number(linha);
    if (!linhasTexto[idx]) return JSON.stringify({ ok: false, erro: 'Linha não encontrada no arquivo.' });

    var cel = linhasTexto[idx].split('\t').map(function(c) { return c.replace(/^"|"$/g, ''); });
    if (cel.length < 18) return JSON.stringify({ ok: false, erro: 'Formato de linha inesperado.' });

    var custoUnit = numVal(cel[C_COMPRAS.custo_atual]);
    var novoTotal = Math.round(qtd * custoUnit * 100) / 100;
    cel[C_COMPRAS.qtd]   = formatBR(qtd, 4);
    cel[C_COMPRAS.total] = formatBR(novoTotal, 2);

    linhasTexto[idx] = cel.map(function(c) { return '"' + c + '"'; }).join('\t');
    file.setContent(linhasTexto.join('\n'));

    Logger.log('Compra editada: ' + arquivo + ' linha ' + idx + ' -> qtd=' + qtd + ' total=' + novoTotal);
    return JSON.stringify({ ok: true, qtd: qtd, total: novoTotal });
  } catch (err) {
    Logger.log('editarQtdCompra ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Lê todas as contagens de estoque (só linhas de Inventário) com metadados de origem.
function lerContagensBrutas() {
  var linhas = [];
  arquivosDoTipo('estoque').forEach(function(f) {
    var linhasTexto = conteudoDoArquivo(f).split(/\r?\n/);
    for (var i = 1; i < linhasTexto.length; i++) {
      if (!linhasTexto[i]) continue;
      var cel = linhasTexto[i].split('\t').map(function(c) { return c.replace(/^"|"$/g, ''); });
      if (cel.length < 16) continue;
      if (cel[C_ESTOQUE.tp_movto] !== ESTOQUE_TIPO_VALIDO) continue;
      var dataInfo = parseDataCompleta(cel[C_ESTOQUE.data]);
      if (!dataInfo) continue;
      linhas.push({
        arquivo: f.getName(), linha: i, ts: dataInfo.ts, mes: dataInfo.mes, ano: dataInfo.ano,
        filial: cel[C_ESTOQUE.filial], grupo: cel[C_ESTOQUE.grupo], produto: cel[C_ESTOQUE.produto],
        centro: cel[C_ESTOQUE.centro], unid: cel[C_ESTOQUE.unid],
        saldo: numVal(cel[C_ESTOQUE.saldo]), custo_unit: numVal(cel[C_ESTOQUE.custo_unit]),
        custo_total: numVal(cel[C_ESTOQUE.custo_total])
      });
    }
  });
  return linhas;
}

// Dado o conjunto de linhas de contagem (lerContagensBrutas), acha o ts (data)
// da contagem INICIAL e FINAL de um mês — mesmo pareamento usado no CMV:
// a FINAL é a data mais recente cujo mês bate com o selecionado; a INICIAL é
// a contagem imediatamente anterior a essa (pode ser do mês anterior).
function tsInicialEFinalDoMes(mesNome, linhas) {
  var porTs = {};
  linhas.forEach(function(l) { porTs[l.ts] = porTs[l.ts] || { mes: l.mes }; });
  var tsOrdenados = Object.keys(porTs).sort();

  var tsFinal = null;
  tsOrdenados.forEach(function(ts) {
    if (NOMES_MESES[porTs[ts].mes] === mesNome) tsFinal = ts; // fica com a mais recente do mes
  });
  if (!tsFinal) return { tsInicial: null, tsFinal: null };

  var posFinal = tsOrdenados.indexOf(tsFinal);
  var tsInicial = posFinal > 0 ? tsOrdenados[posFinal - 1] : null;
  return { tsInicial: tsInicial, tsFinal: tsFinal };
}

// Lista a contagem INICIAL ou FINAL do mês selecionado.
function listarContagemMes(senha, mesNome, qual) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var linhas = lerContagensBrutas();
    if (!linhas.length) return JSON.stringify({ ok: true, linhas: [], data: null });

    var par = tsInicialEFinalDoMes(mesNome, linhas);
    if (!par.tsFinal) return JSON.stringify({ ok: true, linhas: [], data: null });

    var tsAlvo = (qual === 'inicial') ? par.tsInicial : par.tsFinal;
    if (!tsAlvo) return JSON.stringify({ ok: true, linhas: [], data: null });

    var filtradas = linhas.filter(function(l) { return l.ts === tsAlvo; });
    var dataFmt = tsAlvo.slice(6,8) + '/' + tsAlvo.slice(4,6) + '/' + tsAlvo.slice(0,4);
    filtradas.sort(function(a, b) { return b.custo_total - a.custo_total; });
    return JSON.stringify({ ok: true, linhas: filtradas, data: dataFmt });
  } catch (err) {
    Logger.log('listarContagemMes ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Corrige o saldo (quantidade contada) de UMA linha de contagem, recalculando
// o Custo total (Saldo x Custo unit. — o custo unit. fica inalterado).
function editarSaldoContagem(senha, arquivo, linha, novoSaldo) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var saldo = numVal(novoSaldo);
    if (!(saldo >= 0)) return JSON.stringify({ ok: false, erro: 'Saldo inválido.' });

    var it = DriveApp.getFolderById(PASTA_ID).getFilesByName(arquivo);
    if (!it.hasNext()) return JSON.stringify({ ok: false, erro: 'Arquivo não encontrado: ' + arquivo });
    var file = it.next();

    var linhasTexto = conteudoDoArquivo(file).split(/\r?\n/);
    var idx = Number(linha);
    if (!linhasTexto[idx]) return JSON.stringify({ ok: false, erro: 'Linha não encontrada no arquivo.' });

    var cel = linhasTexto[idx].split('\t').map(function(c) { return c.replace(/^"|"$/g, ''); });
    if (cel.length < 16) return JSON.stringify({ ok: false, erro: 'Formato de linha inesperado.' });

    var custoUnit = numVal(cel[C_ESTOQUE.custo_unit]);
    var novoTotal = Math.round(saldo * custoUnit * 100) / 100;
    cel[C_ESTOQUE.saldo]       = formatBR(saldo, 4);
    cel[C_ESTOQUE.custo_total] = formatBR(novoTotal, 2);

    linhasTexto[idx] = cel.map(function(c) { return '"' + c + '"'; }).join('\t');
    file.setContent(linhasTexto.join('\n'));

    Logger.log('Contagem editada: ' + arquivo + ' linha ' + idx + ' -> saldo=' + saldo + ' custo_total=' + novoTotal);
    return JSON.stringify({ ok: true, saldo: saldo, custo_total: novoTotal });
  } catch (err) {
    Logger.log('editarSaldoContagem ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// ── RECONCILIAÇÃO DE INSUMOS (EI + Compras - EF = Consumo Real, x Consumo Teórico) ──
// Cruza os dados de estoque e compras (fonte da verdade física) com a demanda
// teórica calculada pela explosão de receita, produto a produto. A diferença
// entre Consumo Real e Consumo Teórico é o principal indício de perda,
// desperdício ou erro de contagem/compra — quanto maior, mais vale investigar.

// Agrega o SALDO (quantidade) de todas as contagens por produto, indexado por
// ts (data) — consolidado (todas as filiais) e por filial. Também guarda a
// unidade de cada produto (da última linha vista) pra exibição.
function agregarSaldosPorProduto(linhasContagem) {
  var porTs = {};
  linhasContagem.forEach(function(l) {
    if (!porTs[l.ts]) porTs[l.ts] = { produtos: {}, unidades: {}, filiais: {} };
    var bucket = porTs[l.ts];
    bucket.produtos[l.produto] = (bucket.produtos[l.produto] || 0) + l.saldo;
    bucket.unidades[l.produto] = l.unid;
    if (!bucket.filiais[l.filial]) bucket.filiais[l.filial] = { produtos: {}, unidades: {} };
    bucket.filiais[l.filial].produtos[l.produto] = (bucket.filiais[l.filial].produtos[l.produto] || 0) + l.saldo;
    bucket.filiais[l.filial].unidades[l.produto] = l.unid;
  });
  return porTs;
}

// Agrega a quantidade COMPRADA por produto e por mês — consolidado e por filial.
// Trata transferência entre unidades igual ao CMC/CMV: a linha de transferência
// fica registrada na filial de DESTINO (como se fosse uma "compra" de um
// fornecedor que é a própria empresa). Pra não distorcer a reconciliação:
//   - Consolidado: transferência NÃO conta como compra nova pra empresa toda —
//     a mercadoria já foi contada quando a origem comprou de verdade externamente.
//   - Filial de DESTINO: conta normalmente (o estoque dela aumentou de verdade).
//   - Filial de ORIGEM: desconta a quantidade enviada (senão pareceria que ela
//     ainda tem esse insumo disponível, inflando o Consumo Real dela).
function agregarComprasPorProduto() {
  var porMes = {};
  arquivosDoTipo('compras').forEach(function(f) {
    var linhasTexto = conteudoDoArquivo(f).split(/\r?\n/);
    for (var i = 1; i < linhasTexto.length; i++) {
      if (!linhasTexto[i]) continue;
      var cel = linhasTexto[i].split('\t').map(function(c) { return c.replace(/^"|"$/g, ''); });
      if (cel.length < 18) continue;
      var mes = mesNum(cel[C_COMPRAS.data]);
      if (!mes) continue;
      var mesNome = NOMES_MESES[mes];
      var produto = limpaCelula(cel[C_COMPRAS.produto]);
      var filial  = limpaCelula(cel[C_COMPRAS.filial]) || 'OUTRA';
      var qtd     = numVal(cel[C_COMPRAS.qtd]);
      var unid    = limpaCelula(cel[C_COMPRAS.unid]);
      if (!produto || qtd <= 0) continue;

      if (!porMes[mesNome]) porMes[mesNome] = { produtos: {}, unidades: {}, filiais: {} };
      var bucket = porMes[mesNome];
      if (!bucket.filiais[filial]) bucket.filiais[filial] = { produtos: {}, unidades: {} };

      var fornecedor = limpaCelula(cel[C_COMPRAS_FORNECEDOR]);
      var pareceTransf = fornecedor.toUpperCase().indexOf(TRANSFERENCIA_MARCADOR) >= 0;
      var filOrig = pareceTransf ? filialOrigem(fornecedor) : null;
      var ehTransf = pareceTransf && filOrig !== filial;

      bucket.unidades[produto] = unid;
      bucket.filiais[filial].unidades[produto] = unid;
      bucket.filiais[filial].produtos[produto] = (bucket.filiais[filial].produtos[produto] || 0) + qtd;

      if (ehTransf) {
        if (!bucket.filiais[filOrig]) bucket.filiais[filOrig] = { produtos: {}, unidades: {} };
        bucket.filiais[filOrig].produtos[produto] = (bucket.filiais[filOrig].produtos[produto] || 0) - qtd;
        bucket.filiais[filOrig].unidades[produto] = unid;
      } else {
        bucket.produtos[produto] = (bucket.produtos[produto] || 0) + qtd;
      }
    }
  });
  return porMes;
}

// Monta a lista reconciliada de UM escopo (geral ou uma filial): união dos
// produtos que aparecem no teórico, na contagem inicial, na contagem final
// ou nas compras — pra nao esconder um item que sumiu do estoque mas nao
// entrou em nenhuma receita vendida no periodo.
function montarListaReconciliada(teoricoItens, saldosEI, saldosEF, compras, insumosValidos) {
  var teoricoMapa = {}, teoricoUnid = {};
  (teoricoItens || []).forEach(function(it) { teoricoMapa[it.nome] = it.qtde; teoricoUnid[it.nome] = it.und; });

  // O universo de nomes fica restrito a insumos-folha reais (insumosValidos) —
  // evita misturar embalagem/descartavel/bebida revendida que aparecem em
  // compras ou contagem mas nunca sao insumo de nenhuma receita.
  var nomes = {};
  Object.keys(teoricoMapa).forEach(function(n) { nomes[n] = 1; });
  if (saldosEI) Object.keys(saldosEI.produtos).forEach(function(n) { if (insumosValidos[n]) nomes[n] = 1; });
  if (saldosEF) Object.keys(saldosEF.produtos).forEach(function(n) { if (insumosValidos[n]) nomes[n] = 1; });
  if (compras)  Object.keys(compras.produtos).forEach(function(n) { if (insumosValidos[n]) nomes[n] = 1; });

  var lista = Object.keys(nomes).map(function(produto) {
    var ei = (saldosEI && saldosEI.produtos[produto] !== undefined) ? r4(saldosEI.produtos[produto]) : null;
    var ef = (saldosEF && saldosEF.produtos[produto] !== undefined) ? r4(saldosEF.produtos[produto]) : null;
    var comp = (compras && compras.produtos[produto] !== undefined) ? r4(compras.produtos[produto]) : null;
    var teorico = teoricoMapa[produto] !== undefined ? r4(teoricoMapa[produto]) : 0;
    var completo = ei !== null && ef !== null && comp !== null;
    var real = completo ? r4(ei + comp - ef) : null;
    var diferenca = (real !== null) ? r4(real - teorico) : null;

    var und = teoricoUnid[produto]
      || (saldosEF && saldosEF.unidades[produto])
      || (saldosEI && saldosEI.unidades[produto])
      || (compras && compras.unidades[produto])
      || '';

    return {
      produto: produto, und: und,
      ei: ei, compras: comp, ef: ef,
      consumo_real: real, consumo_teorico: teorico, diferenca: diferenca
    };
  });

  lista.sort(function(a, b) {
    var da = a.diferenca === null ? -1 : Math.abs(a.diferenca);
    var db = b.diferenca === null ? -1 : Math.abs(b.diferenca);
    return db - da;
  });
  return lista;
}

// Reconcilia, por mês (e por filial), Estoque Inicial + Compras - Estoque
// Final (Consumo Real, vindo da contagem física) contra o Consumo Teórico
// (vindo da explosão de receita em calcularDemandaInsumos).
function reconciliarInsumos(demandaInsumos, receitas) {
  var resultado = {};
  var linhasContagem = lerContagensBrutas();
  var saldosPorTs = agregarSaldosPorProduto(linhasContagem);
  var comprasPorMes = agregarComprasPorProduto();
  var insumosValidos = todosInsumosFolha(receitas);

  Object.keys(demandaInsumos).forEach(function(mes) {
    var d = demandaInsumos[mes];
    var par = tsInicialEFinalDoMes(mes, linhasContagem);
    var saldosEI = par.tsInicial ? saldosPorTs[par.tsInicial] : null;
    var saldosEF = par.tsFinal   ? saldosPorTs[par.tsFinal]   : null;
    var compras  = comprasPorMes[mes] || null;

    resultado[mes] = {
      itens: montarListaReconciliada(d.materias_primas.itens, saldosEI, saldosEF, compras, insumosValidos),
      filiais: {}
    };

    if (d.filiais) {
      Object.keys(d.filiais).forEach(function(fil) {
        var saldosEIfil = (saldosEI && saldosEI.filiais[fil]) ? saldosEI.filiais[fil] : null;
        var saldosEFfil = (saldosEF && saldosEF.filiais[fil]) ? saldosEF.filiais[fil] : null;
        var comprasFil  = (compras && compras.filiais[fil]) ? compras.filiais[fil] : null;
        resultado[mes].filiais[fil] = {
          itens: montarListaReconciliada(d.filiais[fil].materias_primas.itens, saldosEIfil, saldosEFfil, comprasFil, insumosValidos)
        };
      });
    }
  });

  return resultado;
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Lê quais PRODUTOS são tratados como "menu de escolha livre" no CMV
// Teórico/Demanda de Insumos (Script Properties, chave PRODUTOS_MENU_ESCOLHA,
// nomes separados por ponto e vírgula — nome de produto pode ter vírgula).
// Sem configurar, usa a lista padrão do sistema (PRODUTOS_MENU_ESCOLHA_PADRAO, em Dados.js).
function obterProdutosMenuEscolha() {
  var valor = PropertiesService.getScriptProperties().getProperty('PRODUTOS_MENU_ESCOLHA');
  if (!valor) return PRODUTOS_MENU_ESCOLHA_PADRAO;
  return valor.split(';')
    .map(function(s) { return s.trim().toUpperCase(); })
    .filter(function(s) { return s; });
}

// Lista os produtos configurados como "menu de escolha livre" — pra marcar
// os checkboxes certos na tela de Ajustes > Configurações.
function listarProdutosMenuEscolha(senha) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    return JSON.stringify({ ok: true, produtos: obterProdutosMenuEscolha() });
  } catch (err) {
    Logger.log('listarProdutosMenuEscolha ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Salva a lista de produtos tratados como "menu de escolha livre" — vem da
// tela como um array com os nomes marcados (pode ser vazio, se nenhum
// produto dever ser tratado como menu).
function salvarProdutosMenuEscolha(senha, listaProdutos) {
  if (!validarSenha(senha)) {
    return JSON.stringify({ ok: false, auth: false, erro: 'Senha invalida.' });
  }
  try {
    var produtos = (listaProdutos || [])
      .map(function(s) { return String(s).trim().toUpperCase(); })
      .filter(function(s) { return s; });
    PropertiesService.getScriptProperties().setProperty('PRODUTOS_MENU_ESCOLHA', produtos.join(';'));
    Logger.log('PRODUTOS_MENU_ESCOLHA atualizado via tela (' + produtos.length + ' produtos).');
    return JSON.stringify({ ok: true, produtos: produtos });
  } catch (err) {
    Logger.log('salvarProdutosMenuEscolha ERROR: ' + err.message + '\n' + err.stack);
    return JSON.stringify({ ok: false, erro: err.message });
  }
}

// Descobre o ANO real de cada mês (o sistema hoje só identifica mês por
// NOME nas estruturas agregadas — limitação já existente, não introduzida
// por esta funcionalidade). Resolve olhando a primeira data real encontrada
// nas linhas de compras daquele mês.
function inferirAnoPorMes(rowsCompras, meses) {
  var anoPorMes = {};
  if (!rowsCompras || !meses) return anoPorMes;
  for (var i = 1; i < rowsCompras.length && Object.keys(anoPorMes).length < meses.length; i++) {
    var r = rowsCompras[i];
    if (!r || r.length < 18) continue;
    var dataInfo = parseDataCompleta(r[C_COMPRAS.data]);
    if (!dataInfo) continue;
    var nomeMes = NOMES_MESES[dataInfo.mes];
    if (meses.indexOf(nomeMes) >= 0 && !anoPorMes[nomeMes]) {
      anoPorMes[nomeMes] = dataInfo.ano;
    }
  }
  return anoPorMes;
}
