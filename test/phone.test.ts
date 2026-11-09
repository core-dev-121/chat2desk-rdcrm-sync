import { describe, expect, it } from 'vitest';
import { InvalidPhoneError, normalizePhone, phoneLookupVariants } from '../src/phone.js';

describe('normalizePhone', () => {
  it.each([
    ['+55 (11) 98888-7777', '5511988887777'],
    ['5511988887777', '5511988887777'],
    ['551188887777', '5511988887777'], // WhatsApp sem o nono dígito
    ['(11) 8888-7777', '5511988887777'], // sem DDI e sem o 9
    ['11988887777', '5511988887777'], // sem DDI
    ['011 98888-7777', '5511988887777'], // zero de operadora
    ['0055 21 99999-0000', '5521999990000'], // prefixo internacional 00
    ['(11) 3333-4444', '551133334444'], // fixo não ganha o 9
    ['+1 (305) 555-0101', '13055550101'], // cliente estrangeiro mantém o DDI
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });

  it('todas as grafias do mesmo celular viram a mesma chave', () => {
    const forms = ['+55 11 98888-7777', '551188887777', '11 8888-7777', '(011) 98888 7777'];
    expect(new Set(forms.map(normalizePhone)).size).toBe(1);
  });

  it.each(['', 'abc', '123', '55 00 98888-7777'])('rejeita "%s"', (raw) => {
    expect(() => normalizePhone(raw)).toThrow(InvalidPhoneError);
  });
});

describe('phoneLookupVariants', () => {
  it('celular: procura com/sem DDI e com/sem nono dígito', () => {
    expect(phoneLookupVariants('5511988887777').sort()).toEqual(
      ['11988887777', '1188887777', '5511988887777', '551188887777'].sort(),
    );
  });
});
