// ============================================================
//  Constantes.gs — Constantes globais do backend
// ============================================================

const ID_PASTA_RAIZ           = "1oD291kfZC72IbDbw5Urw6Xh9cbRRYmYW";
const ID_PLANILHA_LANCAMENTOS = "1lbdyDQV3eRypKlm_JTKLB6vuvh4wB_YeWyWMYLyJAD0";
const CACHE_TTL               = 21600;
const NOME_PLANILHA_DB        = "Lançamentos";

const FILIAIS_ORDEM_GAS = ['BOSQUE GRÃO-PARÁ', 'DUQUE', 'METRÓPOLE', 'PÁTIO BELÉM', 'CD DELALE'];
const FILIAIS_CONFIG_GAS = [
  { chave: 'BOSQUE GRÃO-PARÁ', termos: ['bosque','grao','grão'] },
  { chave: 'DUQUE',            termos: ['duque'] },
  { chave: 'METRÓPOLE',        termos: ['metropole','metrópole'] },
  { chave: 'PÁTIO BELÉM',      termos: ['patio','pátio'] },
  // CD DELALE — Centro de Distribuição/Produção. Usado nos Lançamentos Manuais
  // (perdas/transferências) referentes ao CD, separado das lojas.
  { chave: 'CD DELALE',        termos: ['cd delale'] },
];

const MESES_NUM = {
  JANEIRO:1,FEVEREIRO:2,MARCO:3,ABRIL:4,MAIO:5,JUNHO:6,
  JULHO:7,AGOSTO:8,SETEMBRO:9,OUTUBRO:10,NOVEMBRO:11,DEZEMBRO:12
};

const MIME_SHEETS = 'application/vnd.google-apps.spreadsheet';

// ─── Aliases de cabeçalho da planilha "Lançamentos" ──────────────────────────
const ALIASES_COMPETENCIA = ['competência','competencia','mes','mês','periodo','período','referência','referencia','mesref'];
const ALIASES_FILIAL      = ['filial','loja','unidade','loja/filial','nome filial','nomefilial'];
const ALIASES_PERDAS      = ['perdas_manual','perdasmanual','perdas manual','perdas','perda','ajuste perda','perdas (r$)','perda (r$)','perdasmanuais'];
const ALIASES_TRANSF      = ['transferencias','transferências','transf','transferencia','transferência','transf (r$)','transferencias (r$)'];
const ALIASES_SITE        = ['vendas_site','vendassite','vendas site','site','vendas online','faturamento site','faturamento online','ecommerce'];
const ALIASES_FAT_CD      = ['faturamento_cd','faturamentocd','faturamento cd','fat_cd','fatcd','preco de transferencia','preço de transferência','preco_transferencia','faturamento transferencia','faturamento_transferencia','fat. cd (transferencia)'];