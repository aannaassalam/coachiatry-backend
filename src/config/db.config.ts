import mongoose, { Mongoose } from 'mongoose'

const DB_URI = process.env.MONGODB_URI

/**
 * Connect to Mongo without ever taking the process down.
 *
 * The old version called process.exit(1) on any connection failure. On Elastic
 * Beanstalk that turns a transient blip — or an Atlas IP allowlist that doesn't
 * yet include this instance's egress IP — into a permanent crash loop, and the
 * environment goes Severe. Instead we log, let Mongoose keep retrying in the
 * background, and return the shared mongoose instance either way so the HTTP
 * server stays up and health checks keep passing while the DB reconnects.
 */
export default async function connectDb(): Promise<Mongoose> {
   if (!DB_URI) {
      // Don't throw — a missing env var must not crash-loop the box. Log loudly
      // and let the operator fix the EB environment property; the app stays up
      // (health checks pass) but DB-backed routes will error until it's set.
      console.error(
         '❌ MONGODB_URI is not defined in the environment variables. ' +
            'Set it in the Elastic Beanstalk environment properties.'
      )
      return mongoose
   }

   mongoose.connection.on('connected', () => {
      const { host, port, name } = mongoose.connection
      console.log(`✅ MongoDB Connected: ${host}:${port}/${name}`)
   })
   mongoose.connection.on('error', (err) => {
      console.error(`[mongo] connection error: ${err.message}`)
   })
   mongoose.connection.on('disconnected', () => {
      console.warn('[mongo] disconnected')
   })

   try {
      await mongoose.connect(DB_URI, {
         maxPoolSize: 10,
         minPoolSize: 5,
         // Fail an attempt fast instead of hanging the boot log for 30s when
         // Atlas is unreachable; Mongoose retries on its own after this.
         serverSelectionTimeoutMS: 5000,
      })
   } catch (err: any) {
      console.error(
         `[mongo] initial connection failed: ${err.message}. Retrying in background…`
      )
   }

   return mongoose
}
