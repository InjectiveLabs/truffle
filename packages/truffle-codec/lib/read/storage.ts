import debugModule from "debug";
const debug = debugModule("codec:read:storage");

import * as CodecUtils from "truffle-codec-utils";
import { Slot, Range } from "../types/storage";
import { WordMapping } from "../types/evm";
import { DecoderRequest } from "../types/request";
import { mappingKeyAsHex, keyInfoForPrinting } from "../encode/key";
import BN from "bn.js";

/**
 * convert a slot to a word corresponding to actual storage address
 *
 * if `slot` is an array, return hash of array values.
 * if `slot` array is nested, recurse on sub-arrays
 *
 * @param slot - number or possibly-nested array of numbers
 */
export function slotAddress(slot: Slot): BN {
  if (slot.key !== undefined && slot.path !== undefined) {
    // mapping reference
    return CodecUtils.EVM.keccak256(mappingKeyAsHex(slot.key), slotAddress(slot.path)).add(slot.offset);
  }
  else if (slot.path !== undefined) {
    const pathAddress = slotAddress(slot.path);
    const path: BN = slot.hashPath ? CodecUtils.EVM.keccak256(pathAddress) : pathAddress;
    return path.add(slot.offset);
  }
  else {
    return slot.offset;
  }
}

export function slotAddressPrintout(slot: Slot): string {
  if (slot.key !== undefined && slot.path !== undefined) {
    // mapping reference
    let {type: keyEncoding, value: keyValue} = keyInfoForPrinting(slot.key);
    return "keccak(" + keyValue + " as " + keyEncoding + ", " + slotAddressPrintout(slot.path) + ") + " + slot.offset.toString();
  }
  else if (slot.path !== undefined) {
    const pathAddressPrintout = slotAddressPrintout(slot.path);
    return slot.hashPath
      ? "keccak(" + pathAddressPrintout + ")" + slot.offset.toString()
      : pathAddressPrintout + slot.offset.toString();
  }
  else {
    return slot.offset.toString();
  }
}

/**
 * read slot from storage
 *
 * @param slot - see slotAddress() code to understand how these work
 * @param offset - for array, offset from the keccak determined location
 */
export function* read(storage: WordMapping, slot: Slot): Generator<DecoderRequest, Uint8Array, Uint8Array> {
  debug("Slot printout: %s", slotAddressPrintout(slot));
  const address: BN = slotAddress(slot);

  // debug("reading slot: %o", CodecUtils.toHexString(address));

  const hexAddress = CodecUtils.Conversion.toHexString(address, CodecUtils.EVM.WORD_SIZE);
  let word: Uint8Array = storage[hexAddress];

  //if we can't find the word in the map, we place a request to the invoker to supply it
  //(contract-decoder will look it up from the blockchain, while the debugger will just
  //say 0)
  if(word === undefined) {
    word = yield {
      type: "storage",
      slot: address
    };
  }

  return word;
}

/**
 * read all bytes in some range.
 *
 * parameters `from` and `to` are objects with the following properties:
 *
 *   slot - see the slotAddress() code to understand how these work
 *
 *     ref: https://solidity.readthedocs.io/en/v0.4.23/miscellaneous.html#layout-of-state-variables-in-storage
 *     (search "concatenation")
 *
 *  index - (default: 0) byte index in word
 *
 * @param from - location (see ^)
 * @param to - location (see ^). inclusive.
 * @param length - instead of `to`, number of bytes after `from`
 */
export function* readRange(storage: WordMapping, range: Range): Generator<DecoderRequest, Uint8Array, Uint8Array> {
  debug("readRange %o", range);

  let { from, to, length } = range;

  from = {
    slot: from.slot,
    index: from.index || 0
  };

  if (length !== undefined) {
    to = {
      slot: {
        path: from.slot.path || undefined,
        offset: from.slot.offset.addn(
          Math.floor((from.index + length - 1) / CodecUtils.EVM.WORD_SIZE)
        )
      },
      index: (from.index + length - 1) % CodecUtils.EVM.WORD_SIZE
    };
  } else {
    to = {
      slot: to.slot,
      index: to.index
    }
  }

  debug("normalized readRange %o", {from,to});

  let totalWords: number = to.slot.offset.sub(from.slot.offset).addn(1).toNumber();
  debug("totalWords %o", totalWords);

  let data = new Uint8Array(totalWords * CodecUtils.EVM.WORD_SIZE);

  for (let i = 0; i < totalWords; i++) {
    let offset = from.slot.offset.addn(i);
    const word = yield* read(storage, { ...from.slot, offset });
    if (typeof word !== "undefined") {
      data.set(word, i * CodecUtils.EVM.WORD_SIZE);
    }
  }
  debug("words %o", data);

  data = data.slice(from.index, (totalWords - 1) * CodecUtils.EVM.WORD_SIZE + to.index + 1);

  debug("data: %o", data);

  return data;
}
