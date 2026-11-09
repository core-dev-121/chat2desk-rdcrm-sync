/**
 * Padronização de telefone — chave única da integração (R6).
 *
 * Forma canônica: só dígitos, com DDI. Para celulares brasileiros, sempre com o nono dígito:
 *   "(11) 8888-7777"      -> "5511988887777"
 *   "+55 11 98888-7777"   -> "5511988887777"
 *   "551188887777"        -> "5511988887777"   (WhatsApp ainda entrega alguns números sem o 9)
 *   "011 98888-7777"      -> "5511988887777"   (prefixo de operadora / zero à esquerda)
 *   "(11) 3333-4444"      -> "551133334444"    (fixo: não recebe 9)
 *
 * A mesma função deve ser usada por qualquer fluxo que crie contatos (inclusive o n8n),
 * para que todos cheguem à mesma chave.
 */

export class InvalidPhoneError extends Error {
  constructor(public readonly raw: string) {
    super(`Telefone inválido: "${raw}"`);
    this.name = 'InvalidPhoneError';
  }
}

const BR_DDI = '55';

function isValidDdd(ddd: string): boolean {
  return /^[1-9][1-9]$/.test(ddd);
}

export function normalizePhone(raw: string): string {
  let digits = (raw ?? '').replace(/\D/g, '');
  // "+" ou "00" na frente = o DDI veio explícito e é respeitado
  let explicitDdi = /^\s*\+/.test(raw ?? '');

  // "00" = prefixo internacional; zeros à esquerda = prefixo de operadora ("0xx", "0 21 ...")
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    explicitDdi = true;
  } else digits = digits.replace(/^0+/, '');

  // Sem DDI: 10 dígitos (fixo ou celular antigo) ou 11 (celular com 9)
  if (!explicitDdi && (digits.length === 10 || digits.length === 11)) digits = BR_DDI + digits;

  if (digits.startsWith(BR_DDI) && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    let local = digits.slice(4);
    if (!isValidDdd(ddd)) throw new InvalidPhoneError(raw);

    if (local.length === 8 && /^[6-9]/.test(local)) local = '9' + local; // celular sem o nono dígito
    if (local.length === 9 && !local.startsWith('9')) throw new InvalidPhoneError(raw);

    return BR_DDI + ddd + local;
  }

  // Número estrangeiro (cliente de fora): mantém DDI informado, só dígitos (E.164 sem "+")
  if (digits.length >= 8 && digits.length <= 15 && !digits.startsWith(BR_DDI)) return digits;

  throw new InvalidPhoneError(raw);
}

/**
 * Variações a procurar antes de criar um contato. Cobre registros antigos no CRM
 * gravados sem DDI e/ou sem o nono dígito, para não nascer contato duplicado.
 */
export function phoneLookupVariants(canonical: string): string[] {
  const out = new Set<string>([canonical]);
  if (canonical.startsWith(BR_DDI) && canonical.length === 13) {
    const ddd = canonical.slice(2, 4);
    const local = canonical.slice(4);
    const without9 = local.slice(1);
    out.add(BR_DDI + ddd + without9);
    out.add(ddd + local);
    out.add(ddd + without9);
  } else if (canonical.startsWith(BR_DDI) && canonical.length === 12) {
    out.add(canonical.slice(2));
  }
  return [...out];
}

export function samePhone(a: string, b: string): boolean {
  try {
    return normalizePhone(a) === normalizePhone(b);
  } catch {
    return false;
  }
}
