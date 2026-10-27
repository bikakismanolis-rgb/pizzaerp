import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import type { ShopMenu } from '../../lib/online'
import { Centered, ShopHeader, telHref } from './shared'

/** Απόρρητο της σελίδας παραγγελιών (/s/:slug/privacy): απλά, σε μία σελίδα */
export function PrivacyPage() {
  const { slug = '' } = useParams()
  const [menu, setMenu] = useState<ShopMenu | null | undefined>(undefined)
  useEffect(() => {
    supabase.rpc('shop_menu', { p_slug: slug }).then(({ data }) => setMenu((data as ShopMenu | null) ?? null))
  }, [slug])
  useEffect(() => { if (menu) document.title = `Απόρρητο · ${menu.name}` }, [menu])

  if (menu === undefined) return <Centered>Φόρτωση...</Centered>
  if (menu === null) return <Centered>Δεν βρέθηκε το κατάστημα.</Centered>
  const co = menu.company
  const tel = menu.phone ? <a className="underline" href={telHref(menu.phone)}>{menu.phone}</a> : 'στο τηλέφωνο του μαγαζιού'
  return (
    <div className="min-h-screen bg-stone-100 pb-10">
      <ShopHeader name={menu.name} phone={menu.phone} />
      <article className="max-w-2xl mx-auto px-4 mt-4 card p-5 text-sm grid gap-3 leading-relaxed">
        <h2 className="text-lg font-semibold">Τα στοιχεία σου</h2>
        <p>
          Τα στοιχεία που γράφεις στην παραγγελία τα κρατά {co?.name ? <b>{co.name}</b> : 'το μαγαζί'}
          {co?.vat_no && <> (ΑΦΜ {co.vat_no})</>}{co?.address && <>, {co.address}</>}. Επικοινωνία: {tel}.
        </p>
        <h3 className="font-semibold">Τι κρατάμε και γιατί</h3>
        <p>
          Όνομα, τηλέφωνο, διεύθυνση, σημειώσεις και τι παρήγγειλες: για να ετοιμάσουμε και να σου φέρουμε την παραγγελία,
          να σε πάρουμε τηλέφωνο αν χρειαστεί
          {(menu.loyalty_every || menu.welcome_pct) && <>, και για τις εκπτώσεις (καλωσόρισμα, επιβράβευση), που μετράνε τις παραγγελίες ανά τηλέφωνο</>}.
          Δεν τα δίνουμε σε κανέναν άλλο και δεν σου στέλνουμε διαφημίσεις.
        </p>
        <h3 className="font-semibold">Πληρωμή</h3>
        <p>Αν πληρώσεις online, τα στοιχεία της κάρτας σου τα βλέπει μόνο ο πάροχος πληρωμών (Viva ή Stripe), ποτέ εμείς.</p>
        <h3 className="font-semibold">Για πόσο</h3>
        <p>
          Τα στοιχεία σου σβήνονται αυτόματα 24 μήνες μετά την παραγγελία. Η πώληση μένει στα βιβλία μας χωρίς τα στοιχεία σου,
          όπως ορίζει η φορολογική νομοθεσία.
        </p>
        <h3 className="font-semibold">Τα δικαιώματά σου</h3>
        <p>
          Μπορείς να ζητήσεις να δεις, να διορθώσεις ή να σβήσουμε τα στοιχεία σου: πάρε μας {tel}. Αν θεωρείς ότι δεν τα χειριστήκαμε
          σωστά, μπορείς να απευθυνθείς στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα (<a className="underline" href="https://www.dpa.gr" target="_blank" rel="noreferrer">dpa.gr</a>).
        </p>
        <h3 className="font-semibold">Στη συσκευή σου</h3>
        <p>
          Δεν χρησιμοποιούμε cookies παρακολούθησης ή διαφημίσεων. Στον browser σου μένουν μόνο το καλάθι, τα στοιχεία της τελευταίας
          παραγγελίας (για να μην τα ξαναγράφεις) και ο σύνδεσμος της παραγγελίας σου.
        </p>
        <Link className="btn-secondary justify-self-start" to={`/s/${slug}`}>← Στο μενού</Link>
      </article>
    </div>
  )
}
