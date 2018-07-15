import {Client} from './client';
import {Byte} from "./byte";
import {Versions} from "./versions";
import {Message} from "./message";
import {Frame} from "./frame";
import {StompHeaders} from "./stomp-headers";
import {closeEventCallbackType, frameCallbackType, messageCallbackType} from "./types";
import {StompSubscription} from "./stomp-subscription";
import {Transaction} from "./transaction";

/**
 * The STOMP protocol handler
 *
 * @internal
 */
export class StompHandler {
  get debug() {
    return this._client.debug;
  }

  get connectHeaders() {
    return this._client.connectHeaders;
  }

  get disconnectHeaders() {
    return this._client.disconnectHeaders;
  }

  get heartbeatIncoming() {
    return this._client.heartbeatIncoming;
  }

  get heartbeatOutgoing() {
    return this._client.heartbeatOutgoing;
  }

  get onUnhandledMessage() {
    return this._client.onUnhandledMessage;
  }

  get onReceipt() {
    return this._client.onReceipt;
  }

  get maxWebSocketFrameSize() {
    return this._client.maxWebSocketFrameSize;
  }

  public onConnect: frameCallbackType;

  public onDisconnect: frameCallbackType;

  public onStompError: frameCallbackType;

  public onWebSocketClose: closeEventCallbackType;


  /**
   * version of STOMP protocol negotiated with the server, READONLY
   */
  get version(): string {
    return this._version;
  }

  private _version: string;

  get connected(): boolean {
    return this._connected;
  }

  private _connected: boolean;

  private _subscriptions: { [key: string]: messageCallbackType };
  private _partialData: string;
  private _escapeHeaderValues: boolean;
  private _counter: number;
  private _pinger: any;
  private _ponger: any;
  private _lastServerActivityTS: number;
  private _closeReceipt: string;


  constructor(private _client: Client, private _webSocket: WebSocket) {

    // used to index subscribers
    this._counter = 0;

    // subscription callbacks indexed by subscriber's ID
    this._subscriptions = {};

    this._partialData = '';

    this._escapeHeaderValues = false;

    this._lastServerActivityTS = Date.now();
  }

  public start(): void {
    this._webSocket.onmessage = (evt: any) => {
      this.debug('Received data');
      const data = (() => {
        if ((typeof(ArrayBuffer) !== 'undefined') && evt.data instanceof ArrayBuffer) {
          // the data is stored inside an ArrayBuffer, we decode it to get the
          // data as a String
          const arr = new Uint8Array(evt.data);
          this.debug(`--- got data length: ${arr.length}`);
          // Return a string formed by all the char codes stored in the Uint8array
          let j, len1, results;
          results = [];
          for (j = 0, len1 = arr.length; j < len1; j++) {
            const c = arr[j];
            results.push(String.fromCharCode(c));
          }

          return results.join('');
        } else {
          // take the data directly from the WebSocket `data` field
          return evt.data;
        }
      })();
      this.debug(data);
      this._lastServerActivityTS = Date.now();
      if (data === Byte.LF) { // heartbeat
        this.debug("<<< PONG");
        return;
      }
      this.debug(`<<< ${data}`);
      // Handle STOMP frames received from the server
      // The unmarshall function returns the frames parsed and any remaining
      // data from partial frames.
      const unmarshalledData = Frame.unmarshall(this._partialData + data, this._escapeHeaderValues);
      this._partialData = unmarshalledData.partial;
      for (let frame of unmarshalledData.frames) {
        switch (frame.command) {
          // [CONNECTED Frame](http://stomp.github.com/stomp-specification-1.2.html#CONNECTED_Frame)
          case "CONNECTED":
            this.debug(`connected to server ${frame.headers.server}`);
            this._connected = true;
            this._version = <string>frame.headers.version;
            // STOMP version 1.2 needs header values to be escaped
            if (this._version === Versions.V1_2) {
              this._escapeHeaderValues = true;
            }

            /*
                        // If a disconnect was requested while I was connecting, issue a disconnect
                        if (!this._active) {
                          this.deactivate();
                          return;
                        }

            */
            this._setupHeartbeat(frame.headers);
            if (typeof this.onConnect === 'function') {
              this.onConnect(frame);
            }
            break;
          // [MESSAGE Frame](http://stomp.github.com/stomp-specification-1.2.html#MESSAGE)
          case "MESSAGE":
            // the `onreceive` callback is registered when the client calls
            // `subscribe()`.
            // If there is registered subscription for the received message,
            // we used the default `onreceive` method that the client can set.
            // This is useful for subscriptions that are automatically created
            // on the browser side (e.g. [RabbitMQ's temporary
            // queues](http://www.rabbitmq.com/stomp.html)).
            const subscription = <string>frame.headers.subscription;
            const onreceive = this._subscriptions[subscription] || this.onUnhandledMessage;
            // bless the frame to be a Message
            const message = <Message>frame;
            if (onreceive) {
              let messageId: string;
              const client = this;
              if (this._version === Versions.V1_2) {
                messageId = <string>message.headers["ack"];
              } else {
                messageId = <string>message.headers["message-id"];
              }
              // add `ack()` and `nack()` methods directly to the returned frame
              // so that a simple call to `message.ack()` can acknowledge the message.
              message.ack = (headers: StompHeaders = {}): void => {
                return client.ack(messageId, subscription, headers);
              };
              message.nack = (headers: StompHeaders = {}): void => {
                return client.nack(messageId, subscription, headers);
              };
              onreceive(message);
            } else {
              this.debug(`Unhandled received MESSAGE: ${message}`);
            }
            break;
          // [RECEIPT Frame](http://stomp.github.com/stomp-specification-1.2.html#RECEIPT)
          //
          // The client instance can set its `onreceipt` field to a function taking
          // a frame argument that will be called when a receipt is received from
          // the server:
          //
          //     client.onreceipt = function(frame) {
          //       receiptID = frame.headers['receipt-id'];
          //       ...
          //     }
          case "RECEIPT":
            // if this is the receipt for a DISCONNECT, close the websocket
            if (frame.headers["receipt-id"] === this._closeReceipt) {
              // Discard the onclose callback to avoid calling the errorCallback when
              // the client is properly disconnected.
              // this._webSocket.onclose = null;
              this._webSocket.close();
              this._cleanUp();
              this.onDisconnect(frame);
            } else {
              if (typeof this.onReceipt === 'function') {
                this.onReceipt(frame);
              }
            }
            break;
          // [ERROR Frame](http://stomp.github.com/stomp-specification-1.2.html#ERROR)
          case "ERROR":
            if (typeof this.onStompError === 'function') {
              this.onStompError(frame);
            }
            break;
          default:
            this.debug(`Unhandled frame: ${frame}`);
        }
      }
    };

    this._webSocket.onclose = (closeEvent: any): void => {
      const msg = `Whoops! Lost connection to ${this._webSocket.url}`;
      this.debug(msg);
      this.onWebSocketClose(closeEvent);
      this._cleanUp();
      // if (typeof this.onStompError === 'function') {
      //   this.onStompError(msg);
      // }
//      this._schedule_reconnect();
    };

    this._webSocket.onopen = () => {
      this.debug('Web Socket Opened...');
      this.connectHeaders["accept-version"] = Versions.supportedVersions();
      this.connectHeaders["heart-beat"] = [this.heartbeatOutgoing, this.heartbeatIncoming].join(',');
      this._transmit("CONNECT", this.connectHeaders);
    };
  }

  private _setupHeartbeat(headers: StompHeaders): void {
    let ttl: number;
    if ((headers.version !== Versions.V1_1 && headers.version !== Versions.V1_2)) {
      return;
    }

    // heart-beat header received from the server looks like:
    //
    //     heart-beat: sx, sy
    const [serverOutgoing, serverIncoming] = (<string>headers['heart-beat']).split(",").map((v: string) => parseInt(v));

    if ((this.heartbeatOutgoing !== 0) && (serverIncoming !== 0)) {
      ttl = Math.max(this.heartbeatOutgoing, serverIncoming);
      this.debug(`send PING every ${ttl}ms`);
      this._pinger = setInterval(() => {
        this._webSocket.send(Byte.LF);
        this.debug(">>> PING");
      }, ttl);
    }

    if ((this.heartbeatIncoming !== 0) && (serverOutgoing !== 0)) {
      ttl = Math.max(this.heartbeatIncoming, serverOutgoing);
      this.debug(`check PONG every ${ttl}ms`);
      this._ponger = setInterval(() => {
        const delta = Date.now() - this._lastServerActivityTS;
        // We wait twice the TTL to be flexible on window's setInterval calls
        if (delta > (ttl * 2)) {
          this.debug(`did not receive server activity for the last ${delta}ms`);
          this._webSocket.close();
        }
      }, ttl);
    }
  }

  private _transmit(command: string, headers: StompHeaders, body: string = ''): void {
    let out = Frame.marshall(command, headers, body, this._escapeHeaderValues);
    this.debug(`>>> ${out}`);
    // if necessary, split the *STOMP* frame to send it on many smaller
    // *WebSocket* frames
    while (true) {
      if (out.length > this.maxWebSocketFrameSize) {
        this._webSocket.send(out.substring(0, this.maxWebSocketFrameSize));
        out = out.substring(this.maxWebSocketFrameSize);
        this.debug(`remaining = ${out.length}`);
      } else {
        this._webSocket.send(out);
        return;
      }
    }
  }

  public dispose(): void {
    if (this.connected) {
      if (!this.disconnectHeaders['receipt']) {
        this.disconnectHeaders['receipt'] = `close-${this._counter++}`;
      }
      this._closeReceipt = <string>this.disconnectHeaders['receipt'];
      try {
        this._transmit("DISCONNECT", this.disconnectHeaders);
      } catch (error) {
        this.debug('Ignoring error during disconnect', error);
      }
      // this._cleanUp();
    } else {
      if (this._webSocket.readyState === WebSocket.CONNECTING || this._webSocket.readyState === WebSocket.OPEN) {
        this._webSocket.close();
      }
    }
  }

  private _cleanUp() {
    this._connected = false;

    if (this._pinger) {
      clearInterval(this._pinger);
    }
    if (this._ponger) {
      clearInterval(this._ponger);
    }
  }

  public send(destination: string, headers: StompHeaders = {}, body: string = ''): void {
    headers.destination = destination;
    this._transmit("SEND", headers, body);
  }

  public subscribe(destination: string, callback: messageCallbackType, headers: StompHeaders = {}): StompSubscription {
    if (!headers.id) {
      headers.id = `sub-${this._counter++}`;
    }
    headers.destination = destination;
    this._subscriptions[<string>headers.id] = callback;
    this._transmit("SUBSCRIBE", headers);
    const client = this;
    return {
      id: <string>headers.id,

      unsubscribe(hdrs) {
        return client.unsubscribe(<string>headers.id, hdrs);
      }
    };
  }

  public unsubscribe(id: string, headers: StompHeaders = {}): void {
    if (headers == null) {
      headers = {};
    }
    delete this._subscriptions[id];
    headers.id = id;
    this._transmit("UNSUBSCRIBE", headers);
  }

  public begin(transactionId: string): Transaction {
    const txId = transactionId || (`tx-${this._counter++}`);
    this._transmit("BEGIN", {
      transaction: txId
    });
    const client = this;
    return {
      id: txId,
      commit(): void {
        client.commit(txId);
      },
      abort(): void {
        client.abort(txId);
      }
    };
  }

  public commit(transactionId: string): void {
    this._transmit("COMMIT", {
      transaction: transactionId
    });
  }

  public abort(transactionId: string): void {
    this._transmit("ABORT", {
      transaction: transactionId
    });
  }

  public ack(messageId: string, subscriptionId: string, headers: StompHeaders = {}): void {
    if (this._version === Versions.V1_2) {
      headers["id"] = messageId;
    } else {
      headers["message-id"] = messageId;
    }
    headers.subscription = subscriptionId;
    this._transmit("ACK", headers);
  }

  public nack(messageId: string, subscriptionId: string, headers: StompHeaders = {}): void {
    if (this._version === Versions.V1_2) {
      headers["id"] = messageId;
    } else {
      headers["message-id"] = messageId;
    }
    headers.subscription = subscriptionId;
    return this._transmit("NACK", headers);
  }

}