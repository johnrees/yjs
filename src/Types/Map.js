'use strict'

module.exports = function (Y) {
  class YMap {
    constructor (os, model, contents, opContents) {
      this._model = model.id
      this.os = os
      this.map = Y.utils.copyObject(model.map)
      this.contents = contents
      this.opContents = opContents
      this.eventHandler = new Y.utils.EventHandler(ops => {
        var userEvents = []
        for (var i in ops) {
          var op = ops[i]
          var oldValue
          // key is the name to use to access (op)content
          var key = op.struct === 'Delete' ? op.key : op.parentSub

          // compute oldValue
          if (this.opContents[key] != null) {
            let prevType = this.opContents[key]
            oldValue = () => {// eslint-disable-line
              return new Promise((resolve) => {
                this.os.requestTransaction(function *() {// eslint-disable-line
                  resolve(yield* this.getType(prevType))
                })
              })
            }
          } else {
            oldValue = this.contents[key]
          }
          // compute op event
          if (op.struct === 'Insert') {
            if (op.left === null) {
              if (op.opContent != null) {
                delete this.contents[key]
                if (op.deleted) {
                  delete this.opContents[key]
                } else {
                  this.opContents[key] = op.opContent
                }
              } else {
                delete this.opContents[key]
                if (op.deleted) {
                  delete this.contents[key]
                } else {
                  this.contents[key] = op.content
                }
              }
              this.map[key] = op.id
              var insertEvent = {
                name: key,
                object: this
              }
              if (oldValue === undefined) {
                insertEvent.type = 'add'
              } else {
                insertEvent.type = 'update'
                insertEvent.oldValue = oldValue
              }
              userEvents.push(insertEvent)
            }
          } else if (op.struct === 'Delete') {
            if (Y.utils.compareIds(this.map[key], op.target)) {
              delete this.opContents[key]
              delete this.contents[key]
              var deleteEvent = {
                name: key,
                object: this,
                oldValue: oldValue,
                type: 'delete'
              }
              userEvents.push(deleteEvent)
            }
          } else {
            throw new Error('Unexpected Operation!')
          }
        }
        this.eventHandler.callEventListeners(userEvents)
      })
    }
    get (key) {
      // return property.
      // if property does not exist, return null
      // if property is a type, return a promise
      if (key == null) {
        throw new Error('You must specify key!')
      }
      if (this.opContents[key] == null) {
        return this.contents[key]
      } else {
        return new Promise((resolve) => {
          var oid = this.opContents[key]
          this.os.requestTransaction(function *() {
            resolve(yield* this.getType(oid))
          })
        })
      }
    }
    /*
      If there is a primitive (not a custom type), then return it.
      Returns all primitive values, if propertyName is specified!
      Note: modifying the return value could result in inconsistencies!
        -- so make sure to copy it first!
    */
    getPrimitive (key) {
      if (key == null) {
        return Y.utils.copyObject(this.contents)
      } else {
        return this.contents[key]
      }
    }
    delete (key) {
      var right = this.map[key]
      if (right != null) {
        var del = {
          target: right,
          struct: 'Delete'
        }
        var eventHandler = this.eventHandler
        var modDel = Y.utils.copyObject(del)
        modDel.key = key
        eventHandler.awaitAndPrematurelyCall([modDel])
        this.os.requestTransaction(function *() {
          yield* this.applyCreatedOperations([del])
          eventHandler.awaitedDeletes(1)
        })
      }
    }
    set (key, value) {
      // set property.
      // if property is a type, return a promise
      // if not, apply immediately on this type an call event

      var right = this.map[key] || null
      var insert = {
        left: null,
        right: right,
        origin: null,
        parent: this._model,
        parentSub: key,
        struct: 'Insert'
      }
      return new Promise((resolve) => {
        if (value instanceof Y.utils.CustomType) {
          // construct a new type
          this.os.requestTransaction(function *() {
            var typeid = yield* value.createType.call(this)
            var type = yield* this.getType(typeid)
            insert.opContent = typeid
            insert.id = this.store.getNextOpId()
            yield* this.applyCreatedOperations([insert])
            resolve(type)
          })
        } else {
          insert.content = value
          insert.id = this.os.getNextOpId()
          var eventHandler = this.eventHandler
          eventHandler.awaitAndPrematurelyCall([insert])

          this.os.requestTransaction(function *() {
            yield* this.applyCreatedOperations([insert])
            eventHandler.awaitedInserts(1)
          })
          resolve(value)
        }
      })
    }
    observe (f) {
      this.eventHandler.addEventListener(f)
    }
    unobserve (f) {
      this.eventHandler.removeEventListener(f)
    }
    /*
      Observe a path.

      E.g.
      ```
      o.set('textarea', Y.TextBind)
      o.observePath(['textarea'], function(t){
        // is called whenever textarea is replaced
        t.bind(textarea)
      })

      returns a Promise that contains a function that removes the observer from the path.
    */
    observePath (path, f) {
      var self = this
      function observeProperty (events) {
        // call f whenever path changes
        for (var i = 0; i < events.length; i++) {
          var event = events[i]
          if (event.name === propertyName) {
            // call this also for delete events!
            var property = self.get(propertyName)
            if (property instanceof Promise) {
              property.then(f)
            } else {
              f(property)
            }
          }
        }
      }

      if (path.length < 1) {
        throw new Error('Path must contain at least one element!')
      } else if (path.length === 1) {
        var propertyName = path[0]
        var property = self.get(propertyName)
        if (property instanceof Promise) {
          property.then(f)
        } else {
          f(property)
        }
        this.observe(observeProperty)
        return Promise.resolve(function () {
          self.unobserve(f)
        })
      } else {
        var deleteChildObservers
        var resetObserverPath = function () {
          var promise = self.get(path[0])
          if (!promise instanceof Promise) {
            // its either not defined or a primitive value
            promise = self.set(path[0], Y.Map)
          }
          return promise.then(function (map) {
            return map.observePath(path.slice(1), f)
          }).then(function (_deleteChildObservers) {
            // update deleteChildObservers
            deleteChildObservers = _deleteChildObservers
            return Promise.resolve() // Promise does not return anything
          })
        }
        var observer = function (events) {
          for (var e in events) {
            var event = events[e]
            if (event.name === path[0]) {
              deleteChildObservers()
              if (event.type === 'add' || event.type === 'update') {
                resetObserverPath()
              }
              // TODO: what about the delete events?
            }
          }
        }
        self.observe(observer)
        return resetObserverPath().then(
          // this promise contains a function that deletes all the child observers
          // and how to unobserve the observe from this object
          Promise.resolve(function () {
            deleteChildObservers()
            self.unobserve(observer)
          })
        )
      }
    }
    * _changed (transaction, op) {
      if (op.struct === 'Delete') {
        op.key = (yield* transaction.getOperation(op.target)).parentSub
      }
      this.eventHandler.receivedOp(op)
    }
  }
  Y.Map = new Y.utils.CustomType({
    class: YMap,
    createType: function * YMapCreator () {
      var modelid = this.store.getNextOpId()
      var model = {
        map: {},
        struct: 'Map',
        type: 'Map',
        id: modelid
      }
      yield* this.applyCreatedOperations([model])
      return modelid
    },
    initType: function * YMapInitializer (os, model) {
      var contents = {}
      var opContents = {}
      var map = model.map
      for (var name in map) {
        var op = yield* this.getOperation(map[name])
        if (op.opContent != null) {
          opContents[name] = op.opContent
        } else {
          contents[name] = op.content
        }
      }
      return new YMap(os, model, contents, opContents)
    }
  })
}
