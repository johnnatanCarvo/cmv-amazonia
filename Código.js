// ============================================================
//  CARVO Consultoria | Amazônia na Cuia — Painel Analítico
//  Code.gs — Ponto de entrada do Apps Script
//  Versão: 1.1
// ============================================================

// ── CONFIGURAÇÃO ─────────────────────────────────────────────
var PASTA_ID = '1XS4NKNDUf4NJaCp_ajjr2K5g0CUYilT1';

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

function doGet() {
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
    var cmv        = processarCMV(rowsEstoque, rowsCompras);
    var fichasMap  = processarFichas(rowsFichas);
    var receitas   = processarReceitas(rowsFichas);

    // Meses disponíveis — derivados dos dados de compras
    var mOrdem = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                  'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
    var meses = mOrdem.filter(function(m) { return cmc[m]; });
    var anoPorMes = inferirAnoPorMes(rowsCompras, meses);

    // Custo médio de compra de cada insumo por mês — usado pro CMV Teórico
    // reprecificar pelo custo real de compra, em vez do valor estático da
    // ficha técnica (ver calcularCustoExplodido em Dados.js).
    var historicoPorInsumo = preAgregarCustoMedioPorInsumo(rowsCompras);

    var produtosMenuEscolha = obterProdutosMenuEscolha();
    var cmvTeorico = calcularCMVTeorico(vendas, fichasMap, produtosMenuEscolha, receitas, historicoPorInsumo, anoPorMes);
    var demandaInsumos = calcularDemandaInsumos(vendas, receitas);
    var reconciliacaoInsumos = reconciliarInsumos(demandaInsumos, receitas);

    var analiseQuinzenal = calcularAnaliseQuinzenal(cmv, rowsCompras, rowsVendas, rowsEstoque, meses);

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
      analiseQuinzenal: analiseQuinzenal,
      fichasDisponivel: Object.keys(fichasMap).length > 0
    });

  } catch (err) {
    Logger.log('getPayload ERROR: ' + err.message + '\n' + err.stack);
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
function lerFichaTecnica() {
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

// ── INTEGRAÇÃO COM O SISTEMA DE CONTAGEM/ESTOQUE (projeto Apps Script separado) ──
//
// EXPERIMENTAL / EM VALIDAÇÃO — ainda não é usada por nenhum cálculo de CMV.
// Busca o inventário inicial da semana (setores de domingo à noite + Estoquista
// de segunda de manhã) direto da planilha do outro sistema. Não altera nada
// no fluxo atual — serve só pra testar leitura/permissão antes de integrar de fato.
function buscarInventarioSemanalCMV(unidade, dataDomingo) {
  // dataDomingo: string 'dd/MM/yyyy' referente ao domingo daquela semana (ex: '24/08/2026')
  var SHEET_ID    = '15NWs6IiDMJEOYaiDWPzSSAtHsJoziSpkwaz2yjgkppU';
  var ABA_CONT    = 'CONTAGENS';
  var ABA_ITENS_C = 'ITENS_CONTAGEM';

  var ss      = SpreadsheetApp.openById(SHEET_ID);
  var abaCont = ss.getSheetByName(ABA_CONT);
  var abaIt   = ss.getSheetByName(ABA_ITENS_C);
  if (!abaCont || !abaIt) return { ok: false, erro: 'Abas de contagem não encontradas na planilha.' };

  var partes  = dataDomingo.split('/');
  var domingo = new Date(Number(partes[2]), Number(partes[1]) - 1, Number(partes[0]));
  var segunda = new Date(domingo.getTime() + 24 * 60 * 60 * 1000);
  var dataSegunda = Utilities.formatDate(segunda, 'America/Belem', 'dd/MM/yyyy');

  var contRows   = abaCont.getDataRange().getValues();
  var idsValidos = [];
  for (var i = 1; i < contRows.length; i++) {
    var r       = contRows[i];
    var uni     = String(r[2]).trim();
    var setor   = String(r[3]).trim().toUpperCase();
    var status  = String(r[6]).trim().toUpperCase();
    var dataTxt = String(r[1]).trim();
    if (uni !== unidade || status !== 'CONCLUIDO') continue;

    var dataAlvo = (setor === 'ESTOQUISTA') ? dataSegunda : dataDomingo;
    if (dataTxt.indexOf(dataAlvo) === 0) idsValidos.push(String(r[0]).trim());
  }
  if (!idsValidos.length) {
    return { ok: true, itens: [], aviso: 'Nenhuma contagem encontrada (setores em ' + dataDomingo + ', Estoquista em ' + dataSegunda + ') para ' + unidade };
  }

  var itRows = abaIt.getDataRange().getValues();
  var mapa = {};
  for (var j = 1; j < itRows.length; j++) {
    var ir  = itRows[j];
    var cid = String(ir[0]).trim();
    if (idsValidos.indexOf(cid) === -1) continue;
    var cod = String(ir[1]).trim();
    if (!mapa[cod]) mapa[cod] = { cod: cod, produto: String(ir[2]).trim(), und: String(ir[3]).trim(), qtde: 0 };
    mapa[cod].qtde += Number(ir[4]) || 0;
  }

  return { ok: true, unidade: unidade, dataSetores: dataDomingo, dataEstoquista: dataSegunda, itens: Object.values(mapa) };
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

// ── ANÁLISE QUINZENAL (CMC + CMV) — orquestração ────────────────────────
// Só usa dados já lidos em getPayload (rowsCompras, rowsVendas, rowsEstoque,
// cmv já calculado) — nenhuma leitura adicional de Drive. Os cálculos em si
// (Dados.js) são puros; aqui só monta o pacote por mês e resolve a meta.

// Lê a meta de Script Properties (META_CMV_PCT / META_CMC_PCT). Se não
// estiver configurada, cai no fallback de 40% sem gerar erro.
function obterMetaPct(chave) {
  var valor = PropertiesService.getScriptProperties().getProperty(chave);
  var num = numVal(valor);
  return (valor !== null && valor !== '' && num > 0) ? num : META_PADRAO_PCT;
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

// Monta o pacote quinzenal (compras, vendas, CMC%, CMV) de UM período —
// reaproveitado tanto pro período de referência quanto pros anteriores.
function analisarPeriodoQuinzenal(mesNome, ano, porDiaCompras, porDiaVendas, porTsContagens, cmv, diaCorte) {
  var comprasQ = buscarComprasQuinzenais(porDiaCompras, mesNome, ano, diaCorte);
  var vendasQ  = buscarVendasQuinzenais(porDiaVendas, mesNome, ano, diaCorte);
  var cmc = calcularCMCQuinzenal(comprasQ, vendasQ);
  var cmvQ = calcularCMVQuinzenal(cmv[mesNome], porTsContagens, porDiaCompras, mesNome, ano, diaCorte);
  return {
    mes: mesNome, ano: ano,
    temDados: comprasQ.total > 0 || vendasQ.total > 0,
    compras: comprasQ.total, vendas: vendasQ.total,
    comprasFiliais: comprasQ.filiais, vendasFiliais: vendasQ.filiais,
    cmc_pct: cmc.cmc_pct, cmcFiliais: cmc.filiais,
    cmv: cmvQ
  };
}

// Monta a análise quinzenal completa pra cada mês que tem dado disponível:
// comparação com os 3 períodos equivalentes anteriores, tendência, projeção
// de fechamento, pressão de compras, alertas, diagnóstico e análise textual.
function calcularAnaliseQuinzenal(cmv, rowsCompras, rowsVendas, rowsEstoque, meses) {
  var resultado = {};
  if (!meses || !meses.length) return resultado;

  var metaCMV = obterMetaPct('META_CMV_PCT');
  var metaCMC = obterMetaPct('META_CMC_PCT');
  var diaCorte = QUINZENAL_DIA_CORTE;

  var hoje = new Date();
  var mesHojeNome = NOMES_MESES[hoje.getMonth() + 1];
  var anoHoje = hoje.getFullYear();
  var diaHoje = hoje.getDate();

  // Pré-agrega compras/vendas/contagens UMA VEZ (performance — ver
  // comentário em preAgregarComprasPorDia no Dados.js). Sem isso, os
  // milhares de linhas eram reescaneadas dezenas de vezes por mês analisado.
  var porDiaCompras   = preAgregarComprasPorDia(rowsCompras);
  var porDiaVendas    = preAgregarVendasPorDia(rowsVendas);
  var porTsContagens  = preAgregarContagensPorTs(rowsEstoque);

  var anoPorMes = inferirAnoPorMes(rowsCompras, meses);

  meses.forEach(function(mesNome) {
    var ano = anoPorMes[mesNome];
    if (!ano) return; // sem como saber o ano com confiança -> nao arrisca analise quinzenal

    var ehMesAtualReal = (mesNome === mesHojeNome && ano === anoHoje);
    if (ehMesAtualReal && diaHoje < diaCorte) {
      resultado[mesNome] = {
        mes: mesNome, ano: ano, disponivel: false, aindaNaoChegouDia15: true,
        motivo: 'A análise quinzenal ainda não está disponível. Hoje é dia ' + diaHoje +
          ' — ela será consolidada com os dados de 1 a ' + diaCorte + '.'
      };
      return;
    }

    var atual = analisarPeriodoQuinzenal(mesNome, ano, porDiaCompras, porDiaVendas, porTsContagens, cmv, diaCorte);
    if (!atual.temDados) {
      resultado[mesNome] = {
        mes: mesNome, ano: ano, disponivel: false,
        motivo: 'Não há compras nem vendas registradas entre os dias 1 e ' + diaCorte + ' de ' + mesNome.toLowerCase() + '/' + ano + '.'
      };
      return;
    }

    // 3 períodos anteriores equivalentes (mesmo corte 1..diaCorte)
    var anteriores = [];
    for (var n = 1; n <= 3; n++) {
      var ma = mesAnoAnterior(mesNome, ano, n);
      var p = ma ? analisarPeriodoQuinzenal(ma.mes, ma.ano, porDiaCompras, porDiaVendas, porTsContagens, cmv, diaCorte) : null;
      anteriores.push((p && p.temDados) ? p : null);
    }
    var anterior1 = anteriores[0];

    // Histórico (até 6 meses fechados pra trás) da proporção quinzena/mês —
    // usado pra projeção. "Fechado" = qualquer mês que não seja o mês atual
    // real ainda em andamento.
    var proporcoesVendas = [], proporcoesCompras = [];
    for (var k = 1; k <= 6; k++) {
      var mh = mesAnoAnterior(mesNome, ano, k);
      if (!mh) continue;
      var ehFechado = !(mh.mes === mesHojeNome && mh.ano === anoHoje && diaHoje < diasNoMes(mh.mes, mh.ano));
      if (!ehFechado) continue;
      var vQ = somarPeriodoPreAgregado(porDiaVendas, mh.mes, mh.ano, 1, diaCorte).total;
      var vM = somarVendasMesCompleto(porDiaVendas, mh.mes, mh.ano).total;
      if (vQ > 0 && vM > 0) proporcoesVendas.push(vQ / vM);
      var cQ = somarPeriodoPreAgregado(porDiaCompras, mh.mes, mh.ano, 1, diaCorte).total;
      var cM = somarComprasMesCompleto(porDiaCompras, mh.mes, mh.ano).total;
      if (cQ > 0 && cM > 0) proporcoesCompras.push(cQ / cM);
    }

    var projVendas  = calcularProjecaoMensal(atual.vendas, mesNome, ano, diaCorte, proporcoesVendas);
    var projCompras = calcularProjecaoMensal(atual.compras, mesNome, ano, diaCorte, proporcoesCompras);
    var projCmcPct  = calcularPct(projCompras.valor, projVendas.valor);

    // CMV projetado: não há como projetar um Estoque Final futuro sem
    // inventar dado, então a projeção mantém o % quinzenal atual como
    // estimativa de fechamento — método simples e sempre documentado como tal.
    var cmvPctAtualNum = atual.cmv.disponivel ? calcularPct(atual.cmv.cmv, atual.vendas) : null;
    var projCmvPct = cmvPctAtualNum;
    var projCmvMetodologia = 'Mantém o % de CMV Quinzenal como estimativa de fechamento — não há Estoque Final futuro real disponível pra projetar variação sem inventar dado.';

    var varComprasPct = anterior1 ? calcularVariacaoPct(atual.compras, anterior1.compras) : null;
    var varVendasPct  = anterior1 ? calcularVariacaoPct(atual.vendas, anterior1.vendas) : null;
    var pressao = calcularPressaoCompras(varComprasPct, varVendasPct);

    var serieCmc = anteriores.slice().reverse().map(function(p) { return p ? p.cmc_pct : null; });
    serieCmc.push(atual.cmc_pct);
    var tendenciaCmc = calcularTendencia(serieCmc);

    var serieCmv = anteriores.slice().reverse().map(function(p) {
      return (p && p.cmv.disponivel) ? calcularPct(p.cmv.cmv, p.vendas) : null;
    });
    serieCmv.push(cmvPctAtualNum);
    var tendenciaCmv = calcularTendencia(serieCmv);

    var desvioCmcPP = calcularDesvioPP(atual.cmc_pct, metaCMC);
    var desvioCmvPP = calcularDesvioPP(cmvPctAtualNum, metaCMV);
    var statusCmc = classificarStatusCusto(desvioCmcPP, tendenciaCmc);
    var statusCmv = classificarStatusCusto(desvioCmvPP, tendenciaCmv);
    var statusPressao = classificarStatusPressao(pressao.nivel);
    var statusVendas = (varVendasPct !== null) ? (varVendasPct >= 0 ? 'POSITIVO' : 'ATENCAO') : null;
    var desvioProjCmvPP = calcularDesvioPP(projCmvPct, metaCMV);
    var desvioProjCmcPP = calcularDesvioPP(projCmcPct, metaCMC);
    var statusProjecao = classificarStatusCusto(desvioProjCmvPP !== null ? desvioProjCmvPP : desvioProjCmcPP, null);

    var statusGeral = diagnosticoGeral([statusCmc, statusCmv, statusPressao, statusProjecao]);

    var dTextoCMV = {
      pct: cmvPctAtualNum, metaPct: metaCMV, desvioPP: desvioCmvPP, status: statusCmv, tendencia: tendenciaCmv,
      mesAnteriorNome: anterior1 ? anterior1.mes : null,
      varAnteriorPP: (anterior1 && anterior1.cmv.disponivel && cmvPctAtualNum !== null)
        ? calcularDesvioPP(cmvPctAtualNum, calcularPct(anterior1.cmv.cmv, anterior1.vendas)) : null,
      varComprasPct: varComprasPct, varVendasPct: varVendasPct, pressao: pressao,
      projecaoPct: projCmvPct, cmvQuinzenal: atual.cmv
    };
    var dTextoCMC = {
      pct: atual.cmc_pct, metaPct: metaCMC, desvioPP: desvioCmcPP, status: statusCmc, tendencia: tendenciaCmc,
      mesAnteriorNome: anterior1 ? anterior1.mes : null,
      varAnteriorPP: anterior1 ? calcularDesvioPP(atual.cmc_pct, anterior1.cmc_pct) : null,
      varComprasPct: varComprasPct, varVendasPct: varVendasPct, pressao: pressao,
      projecaoPct: projCmcPct
    };

    var mesIdx = ORDEM_MESES.indexOf(mesNome) + 1;

    resultado[mesNome] = {
      mes: mesNome, ano: ano, disponivel: true,
      periodo: { inicio: '01/' + pad2(mesIdx) + '/' + ano, fim: pad2(diaCorte) + '/' + pad2(mesIdx) + '/' + ano },

      compras: atual.compras, vendas: atual.vendas,
      comprasFiliais: atual.comprasFiliais, vendasFiliais: atual.vendasFiliais,

      cmc_pct: atual.cmc_pct, metaCMC: metaCMC, desvioCmcPP: desvioCmcPP, tendenciaCmc: tendenciaCmc, statusCmc: statusCmc,
      cmv: atual.cmv, cmvPct: cmvPctAtualNum, metaCMV: metaCMV, desvioCmvPP: desvioCmvPP, tendenciaCmv: tendenciaCmv, statusCmv: statusCmv,

      varComprasPct: varComprasPct, varVendasPct: varVendasPct,
      pressaoCompras: pressao, statusPressao: statusPressao, statusVendas: statusVendas,

      projecaoVendas: projVendas, projecaoCompras: projCompras,
      projecaoCmcPct: projCmcPct, projecaoCmvPct: projCmvPct, projecaoCmvMetodologia: projCmvMetodologia,
      statusProjecao: statusProjecao,

      statusGeral: statusGeral,

      historico: anteriores.map(function(p) {
        if (!p) return null;
        return {
          mes: p.mes, ano: p.ano, compras: p.compras, vendas: p.vendas, cmc_pct: p.cmc_pct,
          cmv_pct: p.cmv.disponivel ? calcularPct(p.cmv.cmv, p.vendas) : null
        };
      }),

      analiseCMV: gerarAnaliseGerencialCMV(mesNome, ano, dTextoCMV),
      analiseCMC: gerarAnaliseGerencialCMC(mesNome, ano, dTextoCMC)
    };
  });

  return resultado;
}