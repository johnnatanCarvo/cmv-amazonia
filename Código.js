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
    var cmvTeorico = calcularCMVTeorico(vendas, fichasMap);

    // Meses disponíveis — derivados dos dados de compras
    var mOrdem = ['JANEIRO','FEVEREIRO','MARÇO','ABRIL','MAIO','JUNHO',
                  'JULHO','AGOSTO','SETEMBRO','OUTUBRO','NOVEMBRO','DEZEMBRO'];
    var meses = mOrdem.filter(function(m) { return cmc[m]; });

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
// O TIPO vem escolhido pelo usuario na tela (compras/vendas/estoque) —
// o arquivo e renomeado para "<tipo>_<nome original>.csv" antes de salvar,
// garantindo que o padrao de leitura (PADROES) sempre reconheca o arquivo,
// independente de como o Cloudfy exportou o nome original.
// Se ja existir um arquivo com o MESMO NOME FINAL, ele e movido para a
// lixeira do Drive (recuperavel) antes de salvar o novo.
function uploadArquivo(senha, nomeArquivoOriginal, conteudoBase64, tipo) {
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

    // Ficha técnica é uma FOTO do momento (não acumula por mês como os outros
    // tipos) — usa sempre o mesmo nome, então um novo envio substitui o
    // anterior automaticamente, nunca fica mais de uma versão coexistindo.
    var nomeFinal;
    if (tipo === 'fichas') {
      nomeFinal = 'fichas_tecnicas.csv';
    } else {
      var semExtensao = nomeArquivoOriginal.replace(/\.csv$/i, '');
      nomeFinal = tipo + '_' + semExtensao + '.csv';
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