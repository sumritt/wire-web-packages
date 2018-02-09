/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

/* eslint no-magic-numbers: "off" */

const Proteus = require('@wireapp/proteus');
const _sodium = require('libsodium-wrappers-sumo');
let sodium = _sodium;

const assert_serialise_deserialise = (local_identity, session) => {
  const bytes = session.serialise();

  const deser = Proteus.session.Session.deserialise(local_identity, bytes);
  const deser_bytes = deser.serialise();

  expect(sodium.to_hex(new Uint8Array(bytes))).toEqual(sodium.to_hex(new Uint8Array(deser_bytes)));
};

const assert_init_from_message = async (ident, store, msg, expected) => {
  const [session, message] = await Proteus.session.Session.init_from_message(ident, store, msg);
  expect(sodium.to_string(message)).toBe(expected);
  return session;
};

class TestStore extends Proteus.session.PreKeyStore {
  constructor(prekeys) {
    super();
    this.prekeys = prekeys;
  }

  get_prekey(prekey_id) {
    const matches = this.prekeys.filter(prekey => prekey.key_id === prekey_id);
    return Promise.resolve(matches[0]);
  }

  remove(prekey_id) {
    const matches = this.prekeys.filter(prekey => prekey.key_id === prekey_id);
    return Promise.resolve().then(() => delete matches[0]);
  }
}

beforeAll(async () => {
  await _sodium.ready;
  sodium = _sodium;
});

describe('Session', () => {
  describe('Setup', () => {
    it('generates a session from a prekey message', async done => {
      try {
        const preKeys = await Proteus.keys.PreKey.generate_prekeys(0, 10);
        const bobStore = new TestStore(preKeys);

        const alice = await Proteus.keys.IdentityKeyPair.new();
        const bob = await Proteus.keys.IdentityKeyPair.new();
        const preKey = await bobStore.get_prekey(0);
        const bobPreKeyBundle = Proteus.keys.PreKeyBundle.new(bob.public_key, preKey);
        const aliceToBob = await Proteus.session.Session.init_from_prekey(alice, bobPreKeyBundle);

        const plaintext = 'Hello Bob!';

        const preKeyMessage = await aliceToBob.encrypt(plaintext);

        const envelope = Proteus.message.Envelope.deserialise(preKeyMessage.serialise());

        const [bobToAlice, decrypted] = await Proteus.session.Session.init_from_message(bob, bobStore, envelope);

        expect(sodium.to_string(decrypted)).toBe(plaintext);
        expect(bobToAlice).toBeDefined();

        done();
      } catch (err) {
        done.fail(err);
      }
    });
  });

  describe('Serialisation', () => {
    it('can be serialised and deserialised to/from CBOR', async done => {
      try {
        const [alice_ident, bob_ident] = await Promise.all([0, 1].map(() => Proteus.keys.IdentityKeyPair.new()));
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toEqual(1);
        expect(alice.pending_prekey.length).toBe(2);

        assert_serialise_deserialise(alice_ident, alice);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('encrypts and decrypts messages', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toBe(1);

        const hello_bob = await alice.encrypt('Hello Bob!');
        const hello_bob_delayed = await alice.encrypt('Hello delay!');

        expect(Object.keys(alice.session_states).length).toBe(1);
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toBe(1);

        const bob = await assert_init_from_message(bob_ident, bob_store, hello_bob, 'Hello Bob!');

        expect(Object.keys(bob.session_states).length).toBe(1);
        expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).toBe(1);

        const hello_alice = await bob.encrypt('Hello Alice!');

        expect(alice.pending_prekey.length).toBe(2);

        expect(sodium.to_string(await alice.decrypt(alice_store, hello_alice))).toBe('Hello Alice!');

        expect(alice.pending_prekey).toBe(null);
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toBe(2);
        expect(alice.remote_identity.fingerprint()).toBe(bob.local_identity.public_key.fingerprint());

        const ping_bob_1 = await alice.encrypt('Ping1!');
        const ping_bob_2 = await alice.encrypt('Ping2!');

        expect(alice.session_states[alice.session_tag.toString()].state.prev_counter).toBe(2);

        expect(ping_bob_1.message).toEqual(jasmine.any(Proteus.message.CipherMessage));
        expect(ping_bob_2.message).toEqual(jasmine.any(Proteus.message.CipherMessage));

        expect(sodium.to_string(await bob.decrypt(bob_store, ping_bob_1))).toBe('Ping1!');

        expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).toBe(2);

        expect(sodium.to_string(await bob.decrypt(bob_store, ping_bob_2))).toBe('Ping2!');

        expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).toBe(2);

        const pong_alice = await bob.encrypt('Pong!');
        expect(sodium.to_string(await alice.decrypt(alice_store, pong_alice))).toBe('Pong!');

        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toBe(3);
        expect(alice.session_states[alice.session_tag.toString()].state.prev_counter).toBe(2);

        const delay_decrypted = await bob.decrypt(bob_store, hello_bob_delayed);
        expect(sodium.to_string(delay_decrypted)).toBe('Hello delay!');

        expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).toBe(2);
        expect(bob.session_states[bob.session_tag.toString()].state.prev_counter).toBe(1);

        assert_serialise_deserialise(alice_ident, alice);
        assert_serialise_deserialise(bob_ident, bob);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('limits the number of receive chains', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        const hello_bob = await alice.encrypt('Hello Bob!');

        const bob = await assert_init_from_message(bob_ident, bob_store, hello_bob, 'Hello Bob!');

        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).toBe(1);
        expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).toBe(1);

        await Promise.all(
          Array.from({length: Proteus.session.Session.MAX_RECV_CHAINS * 2}, async () => {
            const bob_to_alice = await bob.encrypt('ping');
            expect(sodium.to_string(await alice.decrypt(alice_store, bob_to_alice))).toBe('ping');

            const alice_to_bob = await alice.encrypt('pong');
            expect(sodium.to_string(await bob.decrypt(bob_store, alice_to_bob))).toBe('pong');

            expect(alice.session_states[alice.session_tag.toString()].state.recv_chains.length).not.toBeGreaterThan(
              Proteus.session.Session.MAX_RECV_CHAINS
            );

            expect(bob.session_states[bob.session_tag.toString()].state.recv_chains.length).not.toBeGreaterThan(
              Proteus.session.Session.MAX_RECV_CHAINS
            );
          })
        );

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('handles a counter mismatch', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        const message = await alice.encrypt('Hello Bob!');

        const bob = await assert_init_from_message(bob_ident, bob_store, message, 'Hello Bob!');
        const ciphertexts = await Promise.all(
          ['Hello1', 'Hello2', 'Hello3', 'Hello4', 'Hello5'].map(text => bob.encrypt(text))
        );

        expect(sodium.to_string(await alice.decrypt(alice_store, ciphertexts[1]))).toBe('Hello2');
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains[0].message_keys.length).toBe(1);

        assert_serialise_deserialise(alice_ident, alice);

        expect(sodium.to_string(await alice.decrypt(alice_store, ciphertexts[0]))).toBe('Hello1');
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains[0].message_keys.length).toBe(0);

        expect(sodium.to_string(await alice.decrypt(alice_store, ciphertexts[2]))).toBe('Hello3');
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains[0].message_keys.length).toBe(0);

        expect(sodium.to_string(await alice.decrypt(alice_store, ciphertexts[4]))).toBe('Hello5');
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains[0].message_keys.length).toBe(1);

        expect(sodium.to_string(await alice.decrypt(alice_store, ciphertexts[3]))).toBe('Hello4');
        expect(alice.session_states[alice.session_tag.toString()].state.recv_chains[0].message_keys.length).toBe(0);

        await Promise.all(
          ciphertexts.map(async text => {
            try {
              await alice.decrypt(alice_store, text);
              done.fail();
            } catch (error) {
              expect(error instanceof Proteus.errors.DecryptError.DuplicateMessage).toBe(true);
              expect(error.code).toBe(Proteus.errors.DecryptError.CODE.CASE_209);
            }
          })
        );

        assert_serialise_deserialise(alice_ident, alice);
        assert_serialise_deserialise(bob_ident, bob);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('handles multiple prekey messages', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        const hello_bob1 = await alice.encrypt('Hello Bob1!');
        const hello_bob2 = await alice.encrypt('Hello Bob2!');
        const hello_bob3 = await alice.encrypt('Hello Bob3!');

        const [bob, decrypted] = await Proteus.session.Session.init_from_message(bob_ident, bob_store, hello_bob1);

        expect(decrypted).toBeDefined();

        expect(Object.keys(bob.session_states).length).toBe(1);
        expect(sodium.to_string(await bob.decrypt(alice_store, hello_bob2))).toBe('Hello Bob2!');
        expect(Object.keys(bob.session_states).length).toBe(1);
        expect(sodium.to_string(await bob.decrypt(alice_store, hello_bob3))).toBe('Hello Bob3!');
        expect(Object.keys(bob.session_states).length).toBe(1);

        assert_serialise_deserialise(alice_ident, alice);
        assert_serialise_deserialise(bob_ident, bob);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('handles simultaneous prekey messages', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice_prekey = await alice_store.get_prekey(0);
        const alice_bundle = Proteus.keys.PreKeyBundle.new(alice_ident.public_key, alice_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        const hello_bob_encrypted = await alice.encrypt('Hello Bob!');

        const bob = await Proteus.session.Session.init_from_prekey(bob_ident, alice_bundle);
        const hello_alice = await bob.encrypt('Hello Alice!');

        expect(alice.session_tag.toString()).not.toEqual(bob.session_tag.toString());
        expect(hello_alice).toBeDefined();

        const hello_bob_decrypted = await bob.decrypt(bob_store, hello_bob_encrypted);
        expect(sodium.to_string(hello_bob_decrypted)).toBe('Hello Bob!');
        expect(Object.keys(bob.session_states).length).toBe(2);

        expect(sodium.to_string(await alice.decrypt(alice_store, hello_alice))).toBe('Hello Alice!');
        expect(Object.keys(alice.session_states).length).toBe(2);

        const message_alice = await alice.encrypt('That was fast!');
        expect(sodium.to_string(await bob.decrypt(bob_store, message_alice))).toBe('That was fast!');

        const message_bob = await bob.encrypt(':-)');

        expect(sodium.to_string(await alice.decrypt(alice_store, message_bob))).toBe(':-)');
        expect(alice.session_tag.toString()).toEqual(bob.session_tag.toString());

        assert_serialise_deserialise(alice_ident, alice);
        assert_serialise_deserialise(bob_ident, bob);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('handles simultaneous repeated messages', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice_prekey = await alice_store.get_prekey(0);
        const alice_bundle = Proteus.keys.PreKeyBundle.new(alice_ident.public_key, alice_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);
        const hello_bob_plaintext = 'Hello Bob!';
        const hello_bob_encrypted = await alice.encrypt(hello_bob_plaintext);

        const bob = await Proteus.session.Session.init_from_prekey(bob_ident, alice_bundle);
        const hello_alice_plaintext = 'Hello Alice!';
        const hello_alice_encrypted = await bob.encrypt(hello_alice_plaintext);

        expect(alice.session_tag.toString()).not.toEqual(bob.session_tag.toString());

        const hello_bob_decrypted = await bob.decrypt(bob_store, hello_bob_encrypted);
        expect(sodium.to_string(hello_bob_decrypted)).toBe(hello_bob_plaintext);

        const hello_alice_decrypted = await alice.decrypt(alice_store, hello_alice_encrypted);
        expect(sodium.to_string(hello_alice_decrypted)).toBe(hello_alice_plaintext);

        const echo_bob1_plaintext = 'Echo Bob1!';
        const echo_bob1_encrypted = await alice.encrypt(echo_bob1_plaintext);

        const echo_alice1_plaintext = 'Echo Alice1!';
        const echo_alice1_encrypted = await bob.encrypt(echo_alice1_plaintext);

        const echo_bob1_decrypted = await bob.decrypt(bob_store, echo_bob1_encrypted);
        expect(sodium.to_string(echo_bob1_decrypted)).toBe(echo_bob1_plaintext);
        expect(Object.keys(bob.session_states).length).toBe(2);

        const echo_alice1_decrypted = await alice.decrypt(alice_store, echo_alice1_encrypted);
        expect(sodium.to_string(echo_alice1_decrypted)).toBe(echo_alice1_plaintext);
        expect(Object.keys(alice.session_states).length).toBe(2);

        const echo_bob2_plaintext = 'Echo Bob2!';
        const echo_bob2_encrypted = await alice.encrypt(echo_bob2_plaintext);

        const echo_alice2_plaintext = 'Echo Alice2!';
        const echo_alice2_encrypted = await bob.encrypt(echo_alice2_plaintext);

        const echo_bob2_decrypted = await bob.decrypt(bob_store, echo_bob2_encrypted);
        expect(sodium.to_string(echo_bob2_decrypted)).toBe(echo_bob2_plaintext);
        expect(Object.keys(bob.session_states).length).toBe(2);

        const echo_alice2_decrypted = await alice.decrypt(alice_store, echo_alice2_encrypted);
        expect(sodium.to_string(echo_alice2_decrypted)).toBe(echo_alice2_plaintext);
        expect(Object.keys(alice.session_states).length).toBe(2);

        expect(alice.session_tag.toString()).not.toEqual(bob.session_tag.toString());

        const stop_it_plaintext = 'Stop it!';
        const stop_it_encrypted = await alice.encrypt(stop_it_plaintext);

        const stop_it_decrypted = await bob.decrypt(bob_store, stop_it_encrypted);
        expect(sodium.to_string(stop_it_decrypted)).toBe(stop_it_plaintext);
        expect(Object.keys(bob.session_states).length).toBe(2);

        const ok_plaintext = 'OK';
        const ok_encrypted = await bob.encrypt(ok_plaintext);

        const ok_decrypted = await alice.decrypt(alice_store, ok_encrypted);
        expect(sodium.to_string(ok_decrypted)).toBe(ok_plaintext);
        expect(Object.keys(alice.session_states).length).toBe(2);

        expect(alice.session_tag.toString()).toEqual(bob.session_tag.toString());

        assert_serialise_deserialise(alice_ident, alice);
        assert_serialise_deserialise(bob_ident, bob);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('fails retry init from message', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);

        const hello_bob_plaintext = 'Hello Bob!';
        const hello_bob_encrypted = await alice.encrypt(hello_bob_plaintext);

        await assert_init_from_message(bob_ident, bob_store, hello_bob_encrypted, hello_bob_plaintext);

        await Proteus.session.Session.init_from_message(bob_ident, bob_store, hello_bob_encrypted);

        done.fail();
      } catch (error) {
        expect(error instanceof Proteus.errors.DecryptError).toBe(true);
        expect(error.code).toBe(Proteus.errors.DecryptError.CODE.CASE_206);

        done();
      }
    });

    it('skips message keys', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();
        const alice_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store.get_prekey(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);

        const hello_bob_plaintext = 'Hello Bob!';
        const hello_bob_encrypted = await alice.encrypt(hello_bob_plaintext);

        let state = alice.session_states[alice.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(1);
        expect(state.recv_chains[0].chain_key.idx).toBe(0);
        expect(state.send_chain.chain_key.idx).toBe(1);
        expect(state.recv_chains[0].message_keys.length).toBe(0);

        const bob = await assert_init_from_message(bob_ident, bob_store, hello_bob_encrypted, hello_bob_plaintext);

        state = bob.session_states[bob.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(1);
        expect(state.recv_chains[0].chain_key.idx).toBe(1);
        expect(state.send_chain.chain_key.idx).toBe(0);
        expect(state.recv_chains[0].message_keys.length).toBe(0);

        const hello_alice0_plaintext = 'Hello0';
        const hello_alice0_encrypted = await bob.encrypt(hello_alice0_plaintext);

        bob.encrypt('Hello1'); // unused result

        const hello_alice2_plaintext = 'Hello2';
        const hello_alice2_encrypted = await bob.encrypt(hello_alice2_plaintext);

        const hello_alice2_decrypted = await alice.decrypt(alice_store, hello_alice2_encrypted);
        expect(sodium.to_string(hello_alice2_decrypted)).toBe(hello_alice2_plaintext);

        // Alice has two skipped message keys in her new receive chain:
        state = alice.session_states[alice.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(2);
        expect(state.recv_chains[0].chain_key.idx).toBe(3);
        expect(state.send_chain.chain_key.idx).toBe(0);
        expect(state.recv_chains[0].message_keys.length).toBe(2);
        expect(state.recv_chains[0].message_keys[0].counter).toBe(0);
        expect(state.recv_chains[0].message_keys[1].counter).toBe(1);

        const hello_bob0_plaintext = 'Hello0';
        const hello_bob0_encrypted = await alice.encrypt(hello_bob0_plaintext);

        const hello_bob0_decrypted = await bob.decrypt(bob_store, hello_bob0_encrypted);
        expect(sodium.to_string(hello_bob0_decrypted)).toBe(hello_bob0_plaintext);

        // For Bob everything is normal still. A new message from Alice means a
        // new receive chain has been created and again no skipped message keys.

        state = bob.session_states[bob.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(2);
        expect(state.recv_chains[0].chain_key.idx).toBe(1);
        expect(state.send_chain.chain_key.idx).toBe(0);
        expect(state.recv_chains[0].message_keys.length).toBe(0);

        const hello_alice0_decrypted = await alice.decrypt(alice_store, hello_alice0_encrypted);
        expect(sodium.to_string(hello_alice0_decrypted)).toBe(hello_alice0_plaintext);

        // Alice received the first of the two missing messages. Therefore
        // only one message key is still skipped (counter value = 1).

        state = alice.session_states[alice.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(2);
        expect(state.recv_chains[0].message_keys.length).toBe(1);
        expect(state.recv_chains[0].message_keys[0].counter).toBe(1);

        const hello_again0_plaintext = 'Again0';
        const hello_again0_encrypted = await bob.encrypt(hello_again0_plaintext);

        const hello_again1_plaintext = 'Again1';
        const hello_again1_encrypted = await bob.encrypt(hello_again1_plaintext);

        const hello_again1_decrypted = await alice.decrypt(alice_store, hello_again1_encrypted);
        expect(sodium.to_string(hello_again1_decrypted)).toBe(hello_again1_plaintext);

        // Alice received the first of the two missing messages. Therefore
        // only one message key is still skipped (counter value = 1).

        state = alice.session_states[alice.session_tag.toString()].state;
        expect(state.recv_chains.length).toBe(3);
        expect(state.recv_chains[0].message_keys.length).toBe(1);
        expect(state.recv_chains[1].message_keys.length).toBe(1);
        expect(state.recv_chains[0].message_keys[0].counter).toBe(0);
        expect(state.recv_chains[1].message_keys[0].counter).toBe(1);

        const hello_again0_decrypted = await alice.decrypt(alice_store, hello_again0_encrypted);
        expect(sodium.to_string(hello_again0_decrypted)).toBe(hello_again0_plaintext);

        done();
      } catch (err) {
        done.fail(err);
      }
    });

    it('replaces prekeys', async done => {
      try {
        const alice_ident = await Proteus.keys.IdentityKeyPair.new();

        const bob_ident = await Proteus.keys.IdentityKeyPair.new();
        const bob_store1 = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));
        const bob_store2 = new TestStore(await Proteus.keys.PreKey.generate_prekeys(0, 10));

        const bob_prekey = await bob_store1.get_prekey(0);
        expect(bob_prekey.key_id).toBe(0);
        const bob_bundle = Proteus.keys.PreKeyBundle.new(bob_ident.public_key, bob_prekey);

        const alice = await Proteus.session.Session.init_from_prekey(alice_ident, bob_bundle);

        const hello_bob1_plaintext = 'Hello Bob!';
        const hello_bob1_encrypted = await alice.encrypt(hello_bob1_plaintext);

        const bob = await assert_init_from_message(bob_ident, bob_store1, hello_bob1_encrypted, hello_bob1_plaintext);

        expect(Object.keys(bob.session_states).length).toBe(1);

        const hello_bob2_plaintext = 'Hello Bob2!';
        const hello_bob2_encrypted = await alice.encrypt(hello_bob2_plaintext);

        const hello_bob2_decrypted = await bob.decrypt(bob_store1, hello_bob2_encrypted);
        expect(sodium.to_string(hello_bob2_decrypted)).toBe(hello_bob2_plaintext);

        expect(Object.keys(bob.session_states).length).toBe(1);

        const hello_bob3_plaintext = 'Hello Bob3!';
        const hello_bob3_encrypted = await alice.encrypt(hello_bob3_plaintext);

        const hello_bob3_decrypted = await bob.decrypt(bob_store2, hello_bob3_encrypted);
        expect(sodium.to_string(hello_bob3_decrypted)).toBe(hello_bob3_plaintext);

        expect(Object.keys(bob.session_states).length).toBe(1);

        done();
      } catch (err) {
        done.fail(err);
      }
    });
  });
});
